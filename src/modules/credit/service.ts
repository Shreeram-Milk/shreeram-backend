import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import { noopNotifier, type Notifier } from '../notifications/notifier.js'
import { formatRupees } from '../notifications/rules.js'
import type { PaymentService, PaymentStart } from '../payments/service.js'
import type { CreditAccount, CreditRepository, PaymentRequest } from './repository.js'
import type { AdjustmentInput, CreditAccountListQuery, LedgerQuery, PaymentRequestInput, RecordPaymentInput } from './schema.js'

type Dependencies = { repository: CreditRepository; audit: AuditWriter; payments?: Pick<PaymentService, 'start'>; notifier?: Notifier; now?: () => Date }
type Actor = { adminId: string; ip: string | null }

const notAccount = () => new AppError(409, 'NOT_A_CREDIT_ACCOUNT', 'This customer does not have a credit account. Set their customer type to Credit first.')

export function createCreditService({ repository, audit, payments, notifier = noopNotifier, now = () => new Date() }: Dependencies) {
  /** The customer's credit account, or a clear refusal when they do not exist or are not a credit customer. */
  async function creditAccount(customerId: string): Promise<CreditAccount> {
    const found = await repository.getAccount(customerId)
    if (!found) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'That customer does not exist.')
    if (found.customerType !== 'credit') throw notAccount()
    return found
  }
  const log = (actor: Actor, action: string, details: Record<string, unknown>) => audit({ adminId: actor.adminId, action, details, ip: actor.ip })

  return {
    listAccounts: (query: CreditAccountListQuery) => repository.listAccounts(query),

    async get(customerId: string): Promise<{ account: CreditAccount; openRequests: PaymentRequest[] }> {
      const account = await creditAccount(customerId)
      return { account, openRequests: await repository.listOpenRequests(customerId) }
    },

    async ledger(customerId: string, query: LedgerQuery) {
      await creditAccount(customerId)
      return repository.ledger(customerId, query)
    },

    async setLimit(customerId: string, limitPaise: number, actor: Actor): Promise<CreditAccount> {
      await creditAccount(customerId)
      const updated = await repository.setLimit(customerId, limitPaise)
      if (!updated) throw notAccount()
      await log(actor, 'credit_limit_set', { customerId, limitPaise })
      return updated
    },

    async recordPayment(customerId: string, input: RecordPaymentInput, actor: Actor): Promise<CreditAccount> {
      await creditAccount(customerId)
      const updated = await repository.recordPayment(customerId, input, actor.adminId, now())
      await log(actor, 'credit_payment_recorded', { customerId, amountPaise: input.amountPaise, method: input.method })
      return updated
    },

    async addAdjustment(customerId: string, input: AdjustmentInput, actor: Actor): Promise<CreditAccount> {
      await creditAccount(customerId)
      const updated = await repository.addAdjustment(customerId, input, actor.adminId)
      await log(actor, 'credit_adjustment_added', { customerId, direction: input.direction, amountPaise: input.amountPaise })
      return updated
    },

    async createRequest(customerId: string, input: PaymentRequestInput, actor: Actor): Promise<PaymentRequest> {
      const account = await creditAccount(customerId)
      if (input.amountPaise > account.owedPaise) throw new AppError(409, 'REQUEST_EXCEEDS_BALANCE', 'You can ask for at most what the customer owes.', { owedPaise: account.owedPaise })
      const request = await repository.createRequest(customerId, input, actor.adminId)
      await log(actor, 'payment_request_created', { customerId, requestId: request.id, amountPaise: input.amountPaise })
      await notifier.notify({ event: 'payment_requested', customerId, vars: { amount: formatRupees(input.amountPaise) }, link: null, dedupeKey: `payment-request:${request.id}` })
      return request
    },

    async cancelRequest(customerId: string, requestId: string, actor: Actor): Promise<PaymentRequest> {
      const cancelled = await repository.cancelRequest(customerId, requestId, now())
      if (!cancelled) throw new AppError(404, 'PAYMENT_REQUEST_NOT_FOUND', 'That payment request is not open.')
      await log(actor, 'payment_request_cancelled', { customerId, requestId })
      return cancelled
    },

    /** What the customer sees: their limit, what they owe, and any open "pay now" requests. Not a credit customer: nothing to show. */
    async mine(customerId: string): Promise<{ account: Pick<CreditAccount, 'limitPaise' | 'owedPaise' | 'remainingPaise'> | null; requests: PaymentRequest[] }> {
      const account = await repository.getAccount(customerId)
      if (!account || account.customerType !== 'credit') return { account: null, requests: [] }
      return { account: { limitPaise: account.limitPaise, owedPaise: account.owedPaise, remainingPaise: account.remainingPaise }, requests: await repository.listOpenRequests(customerId) }
    },

    /**
     * The customer starts paying an open request online. The request is settled (and what they owe lowered) only once PhonePe
     * confirms the payment. Checked again then: anything paid beyond what is owed by that moment is refunded, never credited.
     */
    async startRequestPayment(customerId: string, requestId: string, idempotencyKey: string): Promise<PaymentStart> {
      if (!payments) throw new AppError(503, 'ONLINE_PAYMENT_UNAVAILABLE', 'Online payment is not available yet.')
      return payments.start({
        customerId, purpose: 'credit_settlement', idempotencyKey,
        plan: async () => {
          const open = (await repository.listOpenRequests(customerId)).find(request => request.id === requestId)
          if (!open) throw new AppError(404, 'PAYMENT_REQUEST_NOT_FOUND', 'That payment request is not open any more.')
          const account = await repository.getAccount(customerId)
          const owed = account?.owedPaise ?? 0
          if (open.amountPaise > owed) throw new AppError(409, 'PAYMENT_EXCEEDS_BALANCE', 'That is more than you owe right now.', { owedPaise: owed })
          return { amountPaise: open.amountPaise, snapshot: { kind: 'payment_request', version: 1 }, paymentRequestId: open.id, expireAfterSeconds: 900 }
        },
      })
    },
  }
}

export type CreditService = ReturnType<typeof createCreditService>
