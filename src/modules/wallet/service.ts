import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import { noopNotifier, type Notifier } from '../notifications/notifier.js'
import { formatRupees } from '../notifications/rules.js'
import type { PaymentStart } from '../payments/service.js'
import type { PaymentPlan } from '../payments/service.js'
import type { PaymentPurpose } from '../payments/repository.js'
import type { RefundRequest, WalletEntry, WalletRepository } from './repository.js'
import { planRefund, topUpRoom, walletEnabled, WALLET_MAX_BALANCE_PAISE, WALLET_MIN_TOP_UP_PAISE } from './rules.js'
import type { AdminRefundListQuery, CancelRefundInput, MarkRefundSentInput, RefundRequestInput, TopUpInput, WalletAdjustmentInput, WalletCustomerListQuery, WalletPageQuery } from './schema.js'

type Actor = { adminId: string; ip: string | null }
type Payments = { start(input: { customerId: string; purpose: PaymentPurpose; idempotencyKey: string; plan: () => Promise<PaymentPlan> }): Promise<PaymentStart> }
type Dependencies = { repository: WalletRepository; payments?: Payments; audit: AuditWriter; notifier?: Notifier; now?: () => Date }

/** What the customer's wallet screen shows. */
export type MyWallet = {
  /** False for credit customers and blocked accounts: they cannot add money or pay with it (a balance they still have can be refunded). */
  enabled: boolean
  balancePaise: number
  /** Money set aside for a refund that is on its way. */
  openRefund: RefundRequest | null
  minTopUpPaise: number
  maxBalancePaise: number
  /** How much more can be added right now. */
  roomPaise: number
}

const notFound = () => new AppError(404, 'CUSTOMER_NOT_FOUND', 'That customer does not exist.')

/**
 * The ShreeRam wallet: money a prepaid customer adds with PhonePe and spends on orders. It is only ever added to through PhonePe
 * confirmations, cancelled or returned orders, and staff corrections; it is spent on orders and refund requests. Refunds go back
 * to the original PhonePe payments and are sent by staff, never by the system.
 */
export function createWalletService({ repository, payments, audit, notifier = noopNotifier, now = () => new Date() }: Dependencies) {
  async function mine(customerId: string): Promise<MyWallet> {
    const summary = await repository.summary(customerId)
    if (!summary) throw notFound()
    return {
      enabled: walletEnabled(summary), balancePaise: summary.balancePaise, openRefund: summary.openRefund,
      minTopUpPaise: WALLET_MIN_TOP_UP_PAISE, maxBalancePaise: WALLET_MAX_BALANCE_PAISE, roomPaise: topUpRoom(summary.balancePaise),
    }
  }

  return {
    mine,

    history: (customerId: string, query: WalletPageQuery): Promise<{ items: WalletEntry[]; total: number }> => repository.entries(customerId, query.page, query.pageSize),

    /**
     * Starts adding money with PhonePe. The wallet grows only once PhonePe confirms the payment (the payments module then writes
     * the line, once). Anything that would take the wallet over its limit by then is refunded, never added.
     */
    async startTopUp(customerId: string, input: TopUpInput): Promise<PaymentStart> {
      if (!payments) throw new AppError(503, 'ONLINE_PAYMENT_UNAVAILABLE', 'Online payment is not available yet.')
      return payments.start({
        customerId, purpose: 'wallet_topup', idempotencyKey: input.idempotencyKey,
        plan: async () => {
          const wallet = await mine(customerId)
          if (!wallet.enabled) throw new AppError(409, 'WALLET_NOT_AVAILABLE', 'The wallet is not available on this account.')
          if (input.amountPaise > wallet.roomPaise) throw new AppError(409, 'WALLET_LIMIT', `A wallet can hold up to ${formatRupees(WALLET_MAX_BALANCE_PAISE)}.`, { roomPaise: wallet.roomPaise })
          return { amountPaise: input.amountPaise, snapshot: { kind: 'wallet_topup', version: 1 }, paymentRequestId: null, expireAfterSeconds: 900 }
        },
      })
    },

    requestRefund: (customerId: string, input: RefundRequestInput): Promise<RefundRequest> => repository.createRefund(customerId, input),

    refunds: (customerId: string): Promise<RefundRequest[]> => repository.refunds(customerId),

    listRefunds: (query: AdminRefundListQuery) => repository.adminRefunds(query),

    /**
     * One request with the customer's whole story (added, spent, refunded before) and a suggested split over their PhonePe
     * payments, newest first, so staff know exactly what to refund where.
     */
    async getRefund(id: string) {
      const refund = await repository.adminRefund(id)
      if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'That refund request does not exist.')
      const record = await repository.record(refund.customerId)
      const suggested = refund.status === 'requested' ? planRefund(refund.amountPaise, refund.topUps) : []
      return { ...refund, totals: record?.totals ?? null, suggested }
    },

    listCustomers: (query: WalletCustomerListQuery) => repository.walletCustomers(query),

    /** Staff refunded it in PhonePe. The customer is told, once. */
    async markSent(id: string, input: MarkRefundSentInput, actor: Actor): Promise<RefundRequest> {
      const refund = await repository.markSent(id, input, actor.adminId, now())
      if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'That refund request does not exist.')
      await audit({ adminId: actor.adminId, action: 'wallet_refund_sent', details: { refundId: id, amountPaise: refund.amountPaise, parts: input.parts }, ip: actor.ip })
      await notifier.notify({ event: 'refund_sent', customerId: refund.customerId, vars: { amount: formatRupees(refund.amountPaise), order: '' }, link: '/wallet', dedupeKey: `wallet-refund:${id}` })
      return refund
    },

    /** Staff will not refund it: the money goes back into the wallet. */
    async cancelRefund(id: string, input: CancelRefundInput, actor: Actor): Promise<RefundRequest> {
      const refund = await repository.cancelRefund(id, input.note, actor.adminId, now())
      if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'That refund request does not exist.')
      await audit({ adminId: actor.adminId, action: 'wallet_refund_cancelled', details: { refundId: id, amountPaise: refund.amountPaise }, ip: actor.ip })
      return refund
    },

    /** A customer's full wallet record for staff, with one page of the activity. */
    async customerWallet(customerId: string, query: WalletPageQuery) {
      const [record, history] = await Promise.all([repository.record(customerId), repository.entries(customerId, query.page, query.pageSize)])
      if (!record) throw notFound()
      return { record, history }
    },

    async adjust(customerId: string, input: WalletAdjustmentInput, actor: Actor): Promise<MyWallet> {
      await repository.adjust(customerId, input, actor.adminId)
      await audit({ adminId: actor.adminId, action: 'wallet_adjusted', details: { customerId, direction: input.direction, amountPaise: input.amountPaise }, ip: actor.ip })
      return mine(customerId)
    },
  }
}

export type WalletService = ReturnType<typeof createWalletService>
