import { randomUUID } from 'node:crypto'
import { AppError } from '../../http/errors.js'
import { PaymentGatewayError, type GatewayStatus, type PaymentGateway } from '../../integrations/payments/gateway.js'
import type { OrderRepository, OrderView } from '../orders/repository.js'
import type { AdminPaymentDetail, Fulfilment, OnlinePayment, PaymentPurpose, PaymentRepository, PaymentSnapshot, PaymentStatus } from './repository.js'
import type { AdminPaymentListQuery, PhonePeWebhook } from './schema.js'

type Logger = { warn(data: object, message: string): void; error(data: object, message: string): void }

type Dependencies = {
  repository: PaymentRepository
  gateway: PaymentGateway
  orders: Pick<OrderRepository, 'findByKeyPrefix'>
  /** Called once a subscription paid online has been written, so its first delivery orders are made at once. */
  onSubscriptionStarted?: (subscriptionId: string) => Promise<void>
  /** Called once when an online payment for an order is confirmed and its orders are written, so the customer can be told. */
  onOrdersPlaced?: (customerId: string, orders: Awaited<ReturnType<Dependencies['orders']['findByKeyPrefix']>>) => Promise<void>
  logger?: Logger
  now?: () => Date
}

/** A payment as its customer sees it. Orders are listed once they exist. */
export type CustomerPaymentView = {
  merchantOrderId: string; purpose: PaymentPurpose; status: PaymentStatus; fulfilment: Fulfilment; amountPaise: number
  failureReason: string; orders: OrderView[]
  /** A subscription or trial paid upfront: the subscription it started, once PhonePe confirmed. */
  subscription: { id: string; number: string } | null
}
/** What the phone needs to open PhonePe's checkout; absent when there is nothing left to pay (already paid). */
export type CheckoutHandle = { environment: 'SANDBOX' | 'PRODUCTION' | 'TEST'; merchantId: string; providerOrderId: string; token: string }
export type PaymentStart = { payment: CustomerPaymentView; checkout: CheckoutHandle | null }

/** What a feature hands over to start a payment: the amount and what it pays for. Built only after the request key is known to be new. */
export type PaymentPlan = { amountPaise: number; snapshot: PaymentSnapshot; paymentRequestId: string | null; expireAfterSeconds: number }

/** A payment PhonePe never resolves is treated as failed this long after it expired. */
const EXPIRY_GRACE_MS = 15 * 60_000
/** The background check looks at payments started in this window: younger ones are probably still on the customer's screen. */
const RECONCILE_MIN_AGE_MS = 60_000
const RECONCILE_MAX_AGE_MS = 3 * 24 * 60 * 60_000
const RECONCILE_BATCH = 50

const silentLogger: Logger = { warn() {}, error() {} }
const newMerchantOrderId = () => `SRM${randomUUID().replaceAll('-', '')}`
const notFound = () => new AppError(404, 'PAYMENT_NOT_FOUND', 'That payment was not found.')

/**
 * Online payments, provider-neutral. The rule everywhere: money is believed only when PhonePe's status API says so. The
 * phone's "success" and a webhook's body are only reasons to ask. Every path that learns of a result ends in the same
 * repository step, which is locked per payment, so a payment confirmed by the phone, the webhook and the background check
 * at the same moment is still delivered exactly once.
 */
export function createPaymentService({ repository, gateway, orders, onSubscriptionStarted, onOrdersPlaced, logger = silentLogger, now = () => new Date() }: Dependencies) {
  async function view(payment: OnlinePayment): Promise<CustomerPaymentView> {
    const snapshot = payment.snapshot as { kind?: string; orderKeyPrefix?: string } | null
    const placed = payment.purpose === 'order' && payment.fulfilment === 'fulfilled' && snapshot?.kind === 'order' && snapshot.orderKeyPrefix
      ? await orders.findByKeyPrefix(payment.customerId, snapshot.orderKeyPrefix)
      : []
    const subscription = payment.purpose === 'subscription' && payment.fulfilment === 'fulfilled' ? await repository.subscriptionOf(payment.id) : null
    return {
      merchantOrderId: payment.merchantOrderId, purpose: payment.purpose, status: payment.status, fulfilment: payment.fulfilment,
      amountPaise: payment.amountPaise, failureReason: payment.failureReason, orders: placed, subscription,
    }
  }

  /** Acts on PhonePe's answer. Safe to call any number of times, from anywhere, at the same moment. */
  async function apply(payment: OnlinePayment, status: GatewayStatus, source: string): Promise<void> {
    if (status.state === 'COMPLETED') {
      const settled = await repository.settle(payment.id, { transactionId: status.transactionId, providerOrderId: status.providerOrderId, reportedAmountPaise: status.amountPaise, method: status.method, source }, now())
      // Without this, a subscription paid just before a cut-off would get its orders only at the next delivery-job run, after
      // production planning already showed that day as final. A failure here is retried by the job within minutes.
      if (settled.changed && settled.fulfilment === 'fulfilled' && payment.purpose === 'subscription' && onSubscriptionStarted) {
        const subscription = await repository.subscriptionOf(payment.id)
        if (subscription) await onSubscriptionStarted(subscription.id).catch(error => logger.error({ paymentId: payment.id, err: error }, 'Making the first subscription orders failed'))
      }
      if (settled.changed && settled.fulfilment === 'fulfilled' && payment.purpose === 'order' && onOrdersPlaced) {
        const prefix = (payment.snapshot as { orderKeyPrefix?: string } | null)?.orderKeyPrefix
        if (prefix) await orders.findByKeyPrefix(payment.customerId, prefix).then(placed => onOrdersPlaced(payment.customerId, placed)).catch(error => logger.error({ paymentId: payment.id, err: error }, 'Telling the customer their order is placed failed'))
      }
      return
    }
    if (status.state === 'FAILED') {
      await repository.markFailed(payment.id, status.errorCode || 'PAYMENT_FAILED', { source })
      return
    }
    if (payment.expiresAt && now().getTime() > Date.parse(payment.expiresAt) + EXPIRY_GRACE_MS) {
      await repository.markFailed(payment.id, 'EXPIRED', { source, providerState: status.state })
    }
  }

  /** Asks PhonePe about a pending payment and records the answer. Returns the payment as it now stands. */
  async function refresh(payment: OnlinePayment, source: string): Promise<OnlinePayment> {
    if (payment.status !== 'pending') return payment
    try {
      await apply(payment, await gateway.fetchStatus(payment.merchantOrderId), source)
    } catch (error) {
      if (!(error instanceof PaymentGatewayError)) throw error
      logger.warn({ paymentId: payment.id, reason: error.message }, 'PhonePe status check failed')
      // PhonePe never saw this payment (creating it failed) and it is long past its time: nothing can ever arrive for it.
      if (!payment.providerOrderId && payment.expiresAt && now().getTime() > Date.parse(payment.expiresAt) + EXPIRY_GRACE_MS) {
        await repository.markFailed(payment.id, 'NOT_CREATED_AT_PROVIDER', { source })
      }
    }
    return (await repository.findById(payment.id)) ?? payment
  }

  /** A request key that was used before: a paid payment returns its result; anything else must be started again with a new key. */
  async function alreadyStarted(payment: OnlinePayment): Promise<PaymentStart> {
    const current = await refresh(payment, 'repeat_start')
    if (current.status === 'pending' || current.status === 'failed') {
      throw new AppError(409, 'PAYMENT_ALREADY_STARTED', 'This payment was already started. Please try again.', { merchantOrderId: current.merchantOrderId, status: current.status })
    }
    return { payment: await view(current), checkout: null }
  }

  async function adminGet(id: string): Promise<AdminPaymentDetail> {
    const payment = await repository.adminFind(id)
    if (!payment) throw notFound()
    return payment
  }

  return {
    /**
     * Starts paying. A repeated request key returns that payment (already paid: its result; otherwise refused, so the phone
     * starts afresh with a new key). The pending payment is written before PhonePe is asked, so PhonePe can never hold a
     * payment this system does not know about.
     */
    async start(input: { customerId: string; purpose: PaymentPurpose; idempotencyKey: string; plan: () => Promise<PaymentPlan> }): Promise<PaymentStart> {
      const earlier = await repository.findByIdempotencyKey(input.customerId, input.idempotencyKey)
      if (earlier) return alreadyStarted(earlier)
      const plan = await input.plan()
      if (!Number.isSafeInteger(plan.amountPaise) || plan.amountPaise < 100) throw new AppError(409, 'PAYMENT_AMOUNT_TOO_SMALL', 'Online payments must be at least ₹1.')
      const expireAfterSeconds = Math.min(3600, Math.max(300, Math.round(plan.expireAfterSeconds)))
      const { payment, created } = await repository.createPending({
        customerId: input.customerId, purpose: input.purpose, amountPaise: plan.amountPaise, merchantOrderId: newMerchantOrderId(),
        idempotencyKey: input.idempotencyKey, paymentRequestId: plan.paymentRequestId, snapshot: plan.snapshot,
        expiresAt: new Date(now().getTime() + expireAfterSeconds * 1000),
      })
      // Two identical presses at the same moment: the second finds the first's payment.
      if (!created) return alreadyStarted(payment)

      let checkout
      try {
        checkout = await gateway.createCheckout({ merchantOrderId: payment.merchantOrderId, amountPaise: payment.amountPaise, expireAfterSeconds })
      } catch (error) {
        const reason = error instanceof PaymentGatewayError ? error.message : 'Unexpected error'
        logger.error({ paymentId: payment.id, reason }, 'PhonePe payment creation failed')
        await repository.addActivity(payment.id, 'provider_error', { reason })
        await repository.markFailed(payment.id, 'PROVIDER_UNAVAILABLE')
        if (error instanceof PaymentGatewayError) throw new AppError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Online payment is not available right now. Please try again in a moment.')
        throw error
      }
      await repository.recordProviderOrder(payment.id, checkout.providerOrderId, checkout.expiresAt)
      return {
        payment: await view(payment),
        checkout: { environment: gateway.sdk.environment, merchantId: gateway.sdk.merchantId, providerOrderId: checkout.providerOrderId, token: checkout.token },
      }
    },

    /** The phone asks after PhonePe's screen closes. Its own idea of the result is never used: PhonePe is asked. Only the payer may ask. */
    async confirm(customerId: string, merchantOrderId: string): Promise<CustomerPaymentView> {
      const payment = await repository.findByMerchantOrderId(merchantOrderId)
      if (!payment || payment.customerId !== customerId) throw notFound()
      return view(await refresh(payment, 'customer'))
    },

    /**
     * PhonePe's webhook. Its Authorization header must match; even then its body is not believed: it only names the payment, and
     * PhonePe's status API is asked. Repeats are recorded once and not processed twice. Throws (so PhonePe retries) only when
     * the answer could not be recorded.
     */
    async webhook(authorization: string | undefined, body: PhonePeWebhook): Promise<void> {
      if (!gateway.verifyWebhook(authorization)) throw new AppError(401, 'WEBHOOK_UNAUTHORISED', 'Not authorised.')
      const merchantOrderId = body.payload.merchantOrderId
      const payment = merchantOrderId ? await repository.findByMerchantOrderId(merchantOrderId) : null
      const eventId = `${body.event}:${body.payload.orderId || merchantOrderId}:${body.payload.state}`
      const event = await repository.recordWebhook({ eventId, eventType: body.event, payload: body, paymentId: payment?.id ?? null })
      if (event.alreadyProcessed) return
      if (!payment) {
        logger.warn({ merchantOrderId, event: body.event }, 'PhonePe webhook for an unknown payment')
        await repository.markWebhookProcessed(event.id)
        return
      }
      await repository.addActivity(payment.id, 'webhook_received', { event: body.event, state: body.payload.state })
      const status = await gateway.fetchStatus(payment.merchantOrderId)
      await apply(payment, status, 'webhook')
      await repository.markWebhookProcessed(event.id)
    },

    /**
     * The safety net: asks PhonePe about every payment still pending (the app was closed, the network dropped, no webhook came).
     * Run every few minutes. One payment's failure never stops the others.
     */
    async reconcile(): Promise<{ checked: number; failures: number }> {
      const at = now().getTime()
      const pending = await repository.listPending(new Date(at - RECONCILE_MAX_AGE_MS), new Date(at - RECONCILE_MIN_AGE_MS), RECONCILE_BATCH)
      let failures = 0
      for (const payment of pending) {
        try {
          await refresh(payment, 'background_check')
        } catch (error) {
          failures += 1
          logger.error({ paymentId: payment.id, err: error }, 'Payment background check failed')
        }
      }
      return { checked: pending.length, failures }
    },

    adminList: (query: AdminPaymentListQuery) => repository.adminList(query),
    adminGet,

    /** Staff press "Check with PhonePe" on a pending payment. */
    async adminRecheck(id: string): Promise<AdminPaymentDetail> {
      const payment = await repository.findById(id)
      if (!payment) throw notFound()
      if (payment.status === 'pending') {
        try {
          await apply(payment, await gateway.fetchStatus(payment.merchantOrderId), 'staff')
        } catch (error) {
          if (error instanceof PaymentGatewayError) throw new AppError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'PhonePe could not be reached. Try again in a moment.')
          throw error
        }
      }
      return adminGet(id)
    },
  }
}

export type PaymentService = ReturnType<typeof createPaymentService>
