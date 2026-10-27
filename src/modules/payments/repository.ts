import type { PoolClient } from 'pg'
import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { AppError } from '../../http/errors.js'
import { likePattern } from '../master-data/shared.js'
import type { PaymentMethodDetails } from '../../integrations/payments/gateway.js'
import { insertOrders, type NewOrder } from '../orders/repository.js'
import { insertSubscription, type SubscriptionDraft } from '../subscriptions/repository.js'
import type { AdminPaymentListQuery } from './schema.js'

export type PaymentPurpose = 'order' | 'credit_settlement' | 'subscription'
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded'
export type Fulfilment = 'none' | 'fulfilled' | 'refund_due'
export type ActivityKind = 'started' | 'provider_order_created' | 'provider_error' | 'status_checked' | 'webhook_received' | 'paid' | 'failed' | 'fulfilled' | 'refund_due'

/** What an online payment pays for, frozen when the customer started paying. Orders are written from it, exactly as quoted. */
export type OrderSnapshot = { kind: 'order'; version: 1; orderKeyPrefix: string; orders: NewOrder[] }
export type RequestSnapshot = { kind: 'payment_request'; version: 1 }
/** A subscription or trial paid upfront: written exactly as drafted once PhonePe confirms. */
export type SubscriptionSnapshot = { kind: 'subscription'; version: 1; draft: SubscriptionDraft }
export type PaymentSnapshot = OrderSnapshot | RequestSnapshot | SubscriptionSnapshot

export type OnlinePayment = {
  id: string; customerId: string; purpose: PaymentPurpose; amountPaise: number; status: PaymentStatus; fulfilment: Fulfilment
  /** Our id for the payment at PhonePe (PhonePe calls it merchantOrderId). */
  merchantOrderId: string
  providerOrderId: string | null; providerTransactionId: string | null
  idempotencyKey: string | null; paymentRequestId: string | null
  expiresAt: string | null; failureReason: string; createdAt: string; paidAt: string | null
  /** How it was paid, once PhonePe confirmed it. */
  method: PaymentMethodDetails | null
  snapshot: unknown
}
export type PaymentActivity = { kind: ActivityKind; detail: Record<string, unknown>; createdAt: string }
export type AdminPaymentRow = Omit<OnlinePayment, 'snapshot' | 'idempotencyKey'> & { customerName: string; customerPhone: string }
export type AdminPaymentDetail = AdminPaymentRow & {
  activity: PaymentActivity[]
  orders: Array<{ id: string; orderNumber: string; status: string; totalPaise: number }>
  refunds: Array<{ amountPaise: number; providerReference: string; createdAt: string }>
  refundDue: Array<{ id: string; amountPaise: number; status: string; reason: string }>
}

/** What PhonePe reported when a payment completed. */
export type Completion = { transactionId: string | null; providerOrderId: string | null; reportedAmountPaise: number | null; method: PaymentMethodDetails | null; source: string }
export type SettleOutcome = { changed: false } | { changed: true; fulfilment: Fulfilment }

export type NewPendingPayment = {
  customerId: string; purpose: PaymentPurpose; amountPaise: number; merchantOrderId: string; idempotencyKey: string
  paymentRequestId: string | null; snapshot: PaymentSnapshot; expiresAt: Date
}

/** Storage for online payments. The Postgres version below is the real one; tests use a fake. */
export interface PaymentRepository {
  /** Writes a new pending payment, or returns the one this customer already started with the same request key (`created: false`). */
  createPending(input: NewPendingPayment): Promise<{ payment: OnlinePayment; created: boolean }>
  findByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<OnlinePayment | null>
  findByMerchantOrderId(merchantOrderId: string): Promise<OnlinePayment | null>
  findById(id: string): Promise<OnlinePayment | null>
  recordProviderOrder(paymentId: string, providerOrderId: string, expiresAt: Date | null): Promise<void>
  addActivity(paymentId: string, kind: ActivityKind, detail?: Record<string, unknown>): Promise<void>
  /** Moves a still-pending payment to failed. False when it was no longer pending (someone else settled it first). */
  markFailed(paymentId: string, reason: string, detail?: Record<string, unknown>): Promise<boolean>
  /**
   * Records a confirmed payment and delivers what it paid for, as one all-or-nothing step under a lock on the payment: the orders
   * are written, or the payment request settled. If that is refused (for example a credit limit in a mixed cart) or the amount
   * PhonePe reports differs, the money is still recorded as received and a "refund pending" item is created instead.
   * A payment that is no longer pending is left untouched (`changed: false`): confirming twice never delivers twice.
   */
  settle(paymentId: string, completion: Completion, now: Date): Promise<SettleOutcome>
  /** The subscription an upfront payment created, once it exists. */
  subscriptionOf(paymentId: string): Promise<{ id: string; number: string } | null>
  /** Pending payments started between the two times, oldest first: the background check asks PhonePe about these. */
  listPending(startedAfter: Date, startedBefore: Date, limit: number): Promise<OnlinePayment[]>
  /** Stores a webhook once. A repeat of one already processed reports `alreadyProcessed`. */
  recordWebhook(input: { eventId: string; eventType: string; payload: unknown; paymentId: string | null }): Promise<{ id: string; alreadyProcessed: boolean }>
  markWebhookProcessed(id: string): Promise<void>
  adminList(query: AdminPaymentListQuery): Promise<{ rows: AdminPaymentRow[]; total: number }>
  adminFind(id: string): Promise<AdminPaymentDetail | null>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const isoOrNull = (value: unknown) => (value === null || value === undefined ? null : iso(value))
const textOrNull = (value: unknown) => (value === null || value === undefined ? null : String(value))

const PAYMENT_COLUMNS = `p.id, p.customer_id, p.purpose, p.amount_paise, p.status, p.fulfilment, p.provider_reference, p.provider_order_id, p.provider_transaction_id,
  p.idempotency_key, p.payment_request_id, p.expires_at, p.failure_reason, p.created_at, p.paid_at, p.checkout_snapshot,
  p.payment_mode, p.payment_instrument, p.payment_bank, p.bank_reference`

/** The stored payment method, or null when it was never reported (paid before 0017, or not paid). */
export function methodFromRow(row: Row): PaymentMethodDetails | null {
  if (!row.payment_mode) return null
  return { mode: String(row.payment_mode), instrument: String(row.payment_instrument ?? ''), bank: String(row.payment_bank ?? ''), bankReference: String(row.bank_reference ?? '') }
}

const toPayment = (row: Row): OnlinePayment => ({
  id: String(row.id), customerId: String(row.customer_id), purpose: row.purpose as PaymentPurpose, amountPaise: Number(row.amount_paise),
  status: row.status as PaymentStatus, fulfilment: row.fulfilment as Fulfilment, merchantOrderId: String(row.provider_reference),
  providerOrderId: textOrNull(row.provider_order_id), providerTransactionId: textOrNull(row.provider_transaction_id),
  idempotencyKey: textOrNull(row.idempotency_key), paymentRequestId: textOrNull(row.payment_request_id),
  expiresAt: isoOrNull(row.expires_at), failureReason: String(row.failure_reason ?? ''), createdAt: iso(row.created_at), paidAt: isoOrNull(row.paid_at),
  method: methodFromRow(row),
  snapshot: row.checkout_snapshot ?? null,
})

const ADMIN_COLUMNS = `${PAYMENT_COLUMNS}, c.name as customer_name, coalesce(c.phone, nullif(c.email, '')) as customer_phone`
/** Staff never need the frozen checkout or the customer's request key. */
const withoutInternals = ({ snapshot: _snapshot, idempotencyKey: _key, ...payment }: OnlinePayment) => payment
const toAdminRow = (row: Row): AdminPaymentRow => ({ ...withoutInternals(toPayment(row)), customerName: String(row.customer_name ?? ''), customerPhone: String(row.customer_phone ?? '') })

/** A snapshot read back from the database is checked before orders are written from it. */
function orderSnapshotOf(value: unknown): OrderSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const snapshot = value as Partial<OrderSnapshot>
  if (snapshot.kind !== 'order' || snapshot.version !== 1 || typeof snapshot.orderKeyPrefix !== 'string' || !Array.isArray(snapshot.orders) || snapshot.orders.length === 0) return null
  return snapshot as OrderSnapshot
}

async function activity(client: Pick<PoolClient, 'query'>, paymentId: string, kind: ActivityKind, detail: Record<string, unknown> = {}): Promise<void> {
  await client.query('insert into payment_activity (payment_id, kind, detail) values ($1, $2, $3::jsonb)', [paymentId, kind, JSON.stringify(detail)])
}

/** Money received that must go back: a "refund pending" item for staff, once per payment, and the payment marked accordingly. */
async function refundDue(client: PoolClient, payment: Row, amountPaise: number, reason: string, code: string, markPayment: boolean): Promise<void> {
  await client.query(
    `insert into prepaid_adjustments (customer_id, payment_id, adjustment_type, status, amount_paise, reason, effective_date, dedupe_key)
     values ($1, $2, 'refund_pending', 'pending', $3, $4, (now() at time zone 'Asia/Kolkata')::date, $5)
     on conflict (dedupe_key) do nothing`,
    [payment.customer_id, payment.id, amountPaise, reason.slice(0, 300), `payment-refund:${String(payment.id)}`],
  )
  if (markPayment) await client.query("update payments set fulfilment = 'refund_due', updated_at = now() where id = $1", [payment.id])
  await activity(client, String(payment.id), 'refund_due', { code, amountPaise })
}

/** How long after the order-by time a payment that was started in time may still be confirmed (UPI and bank confirmations can be slow). Matches the payment expiry grace. */
export const LATE_PAYMENT_GRACE_MS = 15 * 60_000

/**
 * True when a paid checkout can no longer become orders because an own-delivery window it needs has already closed: the customer began
 * paying after the order-by time, or the confirmation arrived more than the grace period after it. A customer who started paying in time
 * and whose bank confirmed a little late still gets the order; the kitchen's "final" plan then moves by at most those few minutes.
 */
export function orderWindowClosed(orders: Array<{ deliveryMethod: string; orderBy: string | null }>, startedAt: Date, now: Date): boolean {
  return orders.some(order => {
    if (order.deliveryMethod !== 'local_delivery' || !order.orderBy) return false
    const closes = Date.parse(order.orderBy)
    return startedAt.getTime() >= closes || now.getTime() >= closes + LATE_PAYMENT_GRACE_MS
  })
}

async function settleOrder(client: PoolClient, payment: Row, now: Date): Promise<void> {
  const snapshot = orderSnapshotOf(payment.checkout_snapshot)
  const amount = Number(payment.amount_paise)
  if (!snapshot) {
    await refundDue(client, payment, amount, 'Paid online, but the order details were unreadable. Refund the payment in PhonePe, then record it.', 'SNAPSHOT_INVALID', true)
    return
  }
  // The window may have closed while the customer was paying. A closed window is already counted as final in the production plan,
  // so the order is not added to it: the money goes back instead. Paying that began in time is honoured for a short grace period.
  if (orderWindowClosed(snapshot.orders, payment.created_at instanceof Date ? payment.created_at : now, now)) {
    await refundDue(client, payment, amount, 'Paid online after the order-by time had passed, so the order was not placed. Refund the payment in PhonePe, then record it.', 'ORDER_WINDOW_CLOSED', true)
    return
  }
  // A savepoint, so a refused order (account blocked, credit limit in a mixed cart) can be undone on its own while the
  // payment itself stays recorded as received.
  await client.query('savepoint fulfil_order')
  try {
    const orders = await insertOrders(client, String(payment.customer_id), snapshot.orders, now, String(payment.id))
    await client.query('release savepoint fulfil_order')
    await client.query("update payments set fulfilment = 'fulfilled', updated_at = now() where id = $1", [payment.id])
    await activity(client, String(payment.id), 'fulfilled', { orderNumbers: orders.map(order => order.orderNumber) })
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    await client.query('rollback to savepoint fulfil_order')
    await refundDue(client, payment, amount, `Paid online, but the order could not be placed (${error.code}). Refund the payment in PhonePe, then record it.`, error.code, true)
  }
}

async function settleSubscription(client: PoolClient, payment: Row): Promise<void> {
  const snapshot = payment.checkout_snapshot as Partial<SubscriptionSnapshot> | null
  const amount = Number(payment.amount_paise)
  if (snapshot?.kind !== 'subscription' || snapshot.version !== 1 || !snapshot.draft || !Array.isArray(snapshot.draft.lines)) {
    await refundDue(client, payment, amount, 'Paid online, but the subscription details were unreadable. Refund the payment in PhonePe, then record it.', 'SNAPSHOT_INVALID', true)
    return
  }
  await client.query('savepoint fulfil_subscription')
  try {
    const subscriptionId = await insertSubscription(client, snapshot.draft, String(payment.id))
    await client.query('release savepoint fulfil_subscription')
    await client.query("update payments set fulfilment = 'fulfilled', updated_at = now() where id = $1", [payment.id])
    await activity(client, String(payment.id), 'fulfilled', { subscriptionId })
  } catch (error) {
    // A database refusal (for example the same request twice) must not lose the money: it is recorded and refunded.
    const code = error instanceof AppError ? error.code : typeof error === 'object' && error !== null && 'code' in error ? `DB_${String((error as { code: unknown }).code)}` : null
    if (!code) throw error
    await client.query('rollback to savepoint fulfil_subscription')
    await refundDue(client, payment, amount, `Paid online, but the subscription could not be started (${code}). Refund the payment in PhonePe, then record it.`, code, true)
  }
}

async function settleRequest(client: PoolClient, payment: Row, now: Date): Promise<void> {
  const amount = Number(payment.amount_paise)
  // The same lock as every other money change for this customer, so the balance read here cannot change underneath.
  await client.query('select id from customers where id = $1 for update', [payment.customer_id])
  const { rows } = await client.query<Row>("select coalesce(sum(case when direction = 'debit' then amount_paise else -amount_paise end), 0) as owed from credit_ledger_entries where customer_id = $1", [payment.customer_id])
  const owed = Math.max(0, Number((rows[0] as Row).owed))
  // Only what is owed is credited; a balance never goes below zero. Anything more (the customer paid twice, or owed less by now) is refunded.
  const credited = Math.min(amount, owed)
  if (credited > 0) {
    await client.query(
      "insert into credit_ledger_entries (customer_id, entry_type, direction, amount_paise, payment_id, description, occurred_on, created_at) values ($1, 'payment_received', 'credit', $2, $3, 'Paid online (PhonePe)', (now() at time zone 'Asia/Kolkata')::date, clock_timestamp())",
      [payment.customer_id, credited, payment.id],
    )
  }
  if (payment.payment_request_id) {
    await client.query("update payment_requests set status = 'paid', payment_id = $2, closed_at = $3 where id = $1 and status = 'open'", [payment.payment_request_id, payment.id, now])
  }
  const excess = amount - credited
  if (excess > 0) await refundDue(client, payment, excess, 'Paid online more than was owed. Refund the difference in PhonePe, then record it.', 'MORE_THAN_OWED', credited === 0)
  if (credited > 0) {
    await client.query("update payments set fulfilment = 'fulfilled', updated_at = now() where id = $1", [payment.id])
    await activity(client, String(payment.id), 'fulfilled', { creditedPaise: credited })
  }
}

export function createPaymentRepository(database: Database): PaymentRepository {
  const findOne = async (where: string, values: unknown[]): Promise<OnlinePayment | null> => {
    const { rows } = await database.query<Row>(`select ${PAYMENT_COLUMNS} from payments p where ${where}`, values)
    return rows[0] ? toPayment(rows[0]) : null
  }

  return {
    createPending: input => withTransaction(database, async client => {
      const { rows } = await client.query<Row>(
        `insert into payments (customer_id, purpose, method, amount_paise, status, provider_reference, idempotency_key, payment_request_id, checkout_snapshot, expires_at)
         values ($1, $2, 'phonepe', $3, 'pending', $4, $5, $6, $7::jsonb, $8)
         on conflict (customer_id, idempotency_key) where idempotency_key is not null do nothing
         returning ${PAYMENT_COLUMNS.replaceAll('p.', '')}`,
        [input.customerId, input.purpose, input.amountPaise, input.merchantOrderId, input.idempotencyKey, input.paymentRequestId, JSON.stringify(input.snapshot), input.expiresAt],
      )
      if (!rows[0]) {
        const { rows: existing } = await client.query<Row>(`select ${PAYMENT_COLUMNS} from payments p where p.customer_id = $1 and p.idempotency_key = $2`, [input.customerId, input.idempotencyKey])
        if (!existing[0]) throw new Error('A payment with this request key exists but could not be read.')
        return { payment: toPayment(existing[0]), created: false }
      }
      const payment = toPayment(rows[0])
      await activity(client, payment.id, 'started', { amountPaise: input.amountPaise, purpose: input.purpose })
      return { payment, created: true }
    }),

    findByIdempotencyKey: (customerId, idempotencyKey) => findOne('p.customer_id = $1 and p.idempotency_key = $2', [customerId, idempotencyKey]),
    findByMerchantOrderId: merchantOrderId => findOne("p.provider_reference = $1 and p.method = 'phonepe'", [merchantOrderId]),
    findById: id => findOne("p.id = $1 and p.method = 'phonepe'", [id]),

    recordProviderOrder: (paymentId, providerOrderId, expiresAt) => withTransaction(database, async client => {
      await client.query('update payments set provider_order_id = $2, expires_at = coalesce($3, expires_at), updated_at = now() where id = $1', [paymentId, providerOrderId, expiresAt])
      await activity(client, paymentId, 'provider_order_created', { providerOrderId })
    }),

    addActivity: (paymentId, kind, detail = {}) => activity(database, paymentId, kind, detail),

    markFailed: (paymentId, reason, detail = {}) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>("update payments set status = 'failed', failure_reason = $2, updated_at = now() where id = $1 and status = 'pending' returning id", [paymentId, reason.slice(0, 300)])
      if (!rows[0]) return false
      await activity(client, paymentId, 'failed', { reason, ...detail })
      return true
    }),

    settle: (paymentId, completion, now) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>('select id, customer_id, purpose, amount_paise, status, payment_request_id, checkout_snapshot, created_at from payments where id = $1 for update', [paymentId])
      const payment = rows[0]
      if (!payment || payment.status !== 'pending') return { changed: false }
      await client.query(
        `update payments set status = 'paid', paid_at = $2, provider_transaction_id = $3, provider_order_id = coalesce(provider_order_id, $4), failure_reason = '',
           payment_mode = $5, payment_instrument = $6, payment_bank = $7, bank_reference = $8, updated_at = now() where id = $1`,
        [paymentId, now, completion.transactionId, completion.providerOrderId, completion.method?.mode ?? null, completion.method?.instrument || null, completion.method?.bank || null, completion.method?.bankReference || null],
      )
      await activity(client, paymentId, 'paid', { source: completion.source, transactionId: completion.transactionId, reportedAmountPaise: completion.reportedAmountPaise, mode: completion.method?.mode ?? null })
      const amount = Number(payment.amount_paise)
      if (completion.reportedAmountPaise !== null && completion.reportedAmountPaise !== amount) {
        // Never deliver against an amount that is not what was asked for: keep the money recorded and send it back.
        await refundDue(client, payment, completion.reportedAmountPaise, `PhonePe reported ₹${completion.reportedAmountPaise / 100} for a ₹${amount / 100} payment. Check it in PhonePe and refund it.`, 'AMOUNT_MISMATCH', true)
      } else if (payment.purpose === 'order') {
        await settleOrder(client, payment, now)
      } else if (payment.purpose === 'subscription') {
        await settleSubscription(client, payment)
      } else {
        await settleRequest(client, payment, now)
      }
      const { rows: after } = await client.query<Row>('select fulfilment from payments where id = $1', [paymentId])
      return { changed: true, fulfilment: (after[0] as Row).fulfilment as Fulfilment }
    }),

    async subscriptionOf(paymentId) {
      const { rows } = await database.query<Row>('select id, subscription_number from subscriptions where payment_id = $1', [paymentId])
      return rows[0] ? { id: String(rows[0].id), number: String(rows[0].subscription_number) } : null
    },

    async listPending(startedAfter, startedBefore, limit) {
      const { rows } = await database.query<Row>(`select ${PAYMENT_COLUMNS} from payments p where p.status = 'pending' and p.method = 'phonepe' and p.created_at > $1 and p.created_at < $2 order by p.created_at limit $3`, [startedAfter, startedBefore, limit])
      return rows.map(toPayment)
    },

    async recordWebhook({ eventId, eventType, payload, paymentId }) {
      const { rows } = await database.query<Row>(
        "insert into payment_events (provider, provider_event_id, event_type, payload, payment_id) values ('phonepe', $1, $2, $3::jsonb, $4) on conflict (provider, provider_event_id) do nothing returning id",
        [eventId.slice(0, 200), eventType.slice(0, 100), JSON.stringify(payload ?? {}), paymentId],
      )
      if (rows[0]) return { id: String(rows[0].id), alreadyProcessed: false }
      const { rows: existing } = await database.query<Row>("select id, processed_at from payment_events where provider = 'phonepe' and provider_event_id = $1", [eventId.slice(0, 200)])
      const row = existing[0] as Row
      return { id: String(row.id), alreadyProcessed: row.processed_at !== null }
    },

    async markWebhookProcessed(id) {
      await database.query('update payment_events set processed_at = now() where id = $1 and processed_at is null', [id])
    },

    async adminList({ status, purpose, search, page, pageSize }) {
      const conditions = ["p.method = 'phonepe'"]
      const values: unknown[] = []
      if (status) { values.push(status); conditions.push(`p.status = $${values.length}`) }
      if (purpose) { values.push(purpose); conditions.push(`p.purpose = $${values.length}`) }
      if (search) {
        values.push(likePattern(search))
        const n = values.length
        conditions.push(`(c.name ilike $${n} escape '\\' or c.phone ilike $${n} escape '\\' or c.email ilike $${n} escape '\\' or p.provider_reference ilike $${n} escape '\\' or p.provider_transaction_id ilike $${n} escape '\\')`)
      }
      const where = conditions.join(' and ')
      values.push(pageSize, (page - 1) * pageSize)
      const { rows } = await database.query<Row>(
        `select ${ADMIN_COLUMNS}, count(*) over () as total from payments p join customers c on c.id = p.customer_id where ${where}
         order by p.created_at desc limit $${values.length - 1} offset $${values.length}`,
        values,
      )
      return { rows: rows.map(toAdminRow), total: rows[0] ? Number(rows[0].total) : 0 }
    },

    async adminFind(id) {
      const { rows } = await database.query<Row>(`select ${ADMIN_COLUMNS} from payments p join customers c on c.id = p.customer_id where p.id = $1 and p.method = 'phonepe'`, [id])
      if (!rows[0]) return null
      const [activityRows, orderRows, refundRows, dueRows] = await Promise.all([
        database.query<Row>('select kind, detail, created_at from payment_activity where payment_id = $1 order by created_at, id', [id]),
        database.query<Row>('select id, order_number, status, total_paise from orders where payment_id = $1 order by order_number', [id]),
        database.query<Row>('select amount_paise, provider_reference, created_at from refunds where payment_id = $1 order by created_at', [id]),
        database.query<Row>(
          `select a.id, a.amount_paise, a.status, a.reason from prepaid_adjustments a
           where a.payment_id = $1 or a.order_id in (select o.id from orders o where o.payment_id = $1) order by a.created_at`,
          [id],
        ),
      ])
      return {
        ...toAdminRow(rows[0]),
        activity: activityRows.rows.map(row => ({ kind: row.kind as ActivityKind, detail: (row.detail ?? {}) as Record<string, unknown>, createdAt: iso(row.created_at) })),
        orders: orderRows.rows.map(row => ({ id: String(row.id), orderNumber: String(row.order_number), status: String(row.status), totalPaise: Number(row.total_paise) })),
        refunds: refundRows.rows.map(row => ({ amountPaise: Number(row.amount_paise), providerReference: String(row.provider_reference), createdAt: iso(row.created_at) })),
        refundDue: dueRows.rows.map(row => ({ id: String(row.id), amountPaise: Number(row.amount_paise ?? 0), status: String(row.status), reason: String(row.reason) })),
      }
    },
  }
}
