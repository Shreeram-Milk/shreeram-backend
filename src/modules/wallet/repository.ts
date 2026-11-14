import type { PoolClient } from 'pg'
import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { AppError } from '../../http/errors.js'
import { addWalletEntry, walletBalance } from './ledger.js'
import { likePattern } from '../master-data/shared.js'
import { formatRupees } from '../notifications/rules.js'
import { leftToRefund, type RefundStatus, type WalletDirection, type WalletEntryType, type WalletTotals } from './rules.js'
import type { AdminRefundListQuery, MarkRefundSentInput, WalletAdjustmentInput, WalletCustomerListQuery } from './schema.js'

type Row = Record<string, unknown>

export type WalletEntry = { id: string; type: WalletEntryType; direction: WalletDirection; amountPaise: number; description: string; orderNumber: string | null; createdAt: string }
/** One PhonePe refund staff sent for a request, against one top-up payment. */
export type RefundPart = { paymentId: string; merchantOrderId: string; amountPaise: number; providerReference: string; createdAt: string }
export type RefundRequest = {
  id: string; customerId: string; amountPaise: number; status: RefundStatus; customerNote: string; providerReference: string; staffNote: string
  requestedAt: string; handledAt: string | null
  /** When the money reached the customer's bank. Filled by the PhonePe refund webhook once live keys are on; null until then. */
  completedAt: string | null
  parts: RefundPart[]
}
export type WalletSummary = { customerType: string; status: string; balancePaise: number; openRefund: RefundRequest | null }
export type AdminRefundRow = RefundRequest & { customerName: string; customerPhone: string; customerEmail: string }
/** A PhonePe payment that added money: what staff refund against (PhonePe refunds always point at an original payment). */
export type TopUpPayment = { paymentId: string; merchantOrderId: string; transactionId: string | null; amountPaise: number; paidAt: string | null; refundedPaise: number; leftPaise: number }
export type WalletCustomer = { customerId: string; name: string; phone: string; email: string; customerType: string; status: string }
export type WalletCustomerRow = WalletCustomer & WalletTotals & { lastActivityAt: string }
/** Across all wallets: money held right now, refunds waiting, and refunded so far. */
export type WalletOverview = { heldPaise: number; customersHolding: number; waitingCount: number; waitingPaise: number; refundedPaise: number }
/** Everything about one customer's wallet: the numbers, every PhonePe top-up (and what went back from it), every refund request. */
export type WalletRecord = { customer: WalletCustomer; totals: WalletTotals; topUps: TopUpPayment[]; refunds: RefundRequest[] }

export interface WalletRepository {
  summary(customerId: string): Promise<WalletSummary | null>
  entries(customerId: string, page: number, pageSize: number): Promise<{ items: WalletEntry[]; total: number }>
  refunds(customerId: string): Promise<RefundRequest[]>
  /** Sets the whole balance aside for a refund. The same request key returns the same request. */
  createRefund(customerId: string, input: { note: string; idempotencyKey: string }): Promise<RefundRequest>
  adminRefunds(query: AdminRefundListQuery): Promise<{ items: AdminRefundRow[]; total: number }>
  adminRefund(id: string): Promise<(AdminRefundRow & { topUps: TopUpPayment[] }) | null>
  /** Every customer who has used the wallet, with their numbers; refunds waiting first. */
  walletCustomers(query: WalletCustomerListQuery): Promise<{ items: WalletCustomerRow[]; total: number; overview: WalletOverview }>
  record(customerId: string): Promise<WalletRecord | null>
  /**
   * Records the PhonePe refunds staff sent (one line per payment in `refunds`) and closes the request. Null when there is no such
   * request; refuses one that is no longer waiting, parts that do not add up, and a payment refunded past what it paid.
   */
  markSent(id: string, input: MarkRefundSentInput, adminId: string, now: Date): Promise<RefundRequest | null>
  cancelRefund(id: string, note: string, adminId: string, now: Date): Promise<RefundRequest | null>
  /** Returns the new balance. */
  adjust(customerId: string, input: WalletAdjustmentInput, adminId: string): Promise<number>
}

const REFUND_COLUMNS = 'r.id, r.customer_id, r.amount_paise, r.status, r.customer_note, r.provider_reference, r.staff_note, r.requested_at, r.handled_at, r.completed_at'
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString())
const toRefund = (row: Row): RefundRequest => ({
  id: String(row.id), customerId: String(row.customer_id), amountPaise: Number(row.amount_paise), status: row.status as RefundStatus,
  customerNote: String(row.customer_note ?? ''), providerReference: String(row.provider_reference ?? ''), staffNote: String(row.staff_note ?? ''),
  requestedAt: iso(row.requested_at) as string, handledAt: iso(row.handled_at), completedAt: iso(row.completed_at), parts: [],
})
const toTopUp = (row: Row): TopUpPayment => {
  const source = { paymentId: String(row.id), amountPaise: Number(row.amount_paise), refundedPaise: Number(row.refunded_paise ?? 0) }
  return { ...source, merchantOrderId: String(row.provider_reference), transactionId: row.provider_transaction_id ? String(row.provider_transaction_id) : null, paidAt: iso(row.paid_at), leftPaise: leftToRefund(source) }
}
const TOP_UP_SELECT = `select p.id, p.provider_reference, p.provider_transaction_id, p.amount_paise, p.paid_at,
  coalesce((select sum(f.amount_paise) from refunds f where f.payment_id = p.id), 0) as refunded_paise
  from payments p where p.customer_id = $1 and p.purpose = 'wallet_topup' and p.status in ('paid', 'partially_refunded', 'refunded')
  order by p.paid_at desc nulls last, p.id desc limit 50`
/** Per-customer numbers straight from the ledger and the requests (the same sums as `walletTotals`). */
const TOTALS_CTE = `per as (
    select customer_id,
      coalesce(sum(amount_paise) filter (where entry_type = 'top_up'), 0) as added,
      coalesce(sum(amount_paise) filter (where entry_type = 'order_payment'), 0) as spent,
      coalesce(sum(amount_paise) filter (where entry_type = 'order_return'), 0) as returned,
      coalesce(sum(case when direction = 'credit' then amount_paise else -amount_paise end) filter (where entry_type = 'manual_adjustment'), 0) as adjusted,
      coalesce(sum(case when direction = 'credit' then amount_paise else -amount_paise end), 0) as balance,
      max(created_at) as last_at
    from wallet_entries group by customer_id
  ), req as (
    select customer_id, coalesce(sum(amount_paise) filter (where status = 'sent'), 0) as refunded, coalesce(sum(amount_paise) filter (where status = 'requested'), 0) as waiting
    from wallet_refund_requests group by customer_id
  )`
const toTotals = (row: Row): WalletTotals => ({
  addedPaise: Number(row.added ?? 0), spentPaise: Number(row.spent ?? 0), returnedPaise: Number(row.returned ?? 0), refundedPaise: Number(row.refunded ?? 0),
  waitingPaise: Number(row.waiting ?? 0), adjustedPaise: Number(row.adjusted ?? 0), balancePaise: Number(row.balance ?? 0),
})
const toCustomer = (row: Row): WalletCustomer => ({
  customerId: String(row.customer_id ?? row.id), name: String(row.name ?? ''), phone: String(row.phone ?? ''), email: String(row.email ?? ''),
  customerType: String(row.customer_type ?? ''), status: String(row.status ?? ''),
})
const toAdminRefund = (row: Row): AdminRefundRow => ({ ...toRefund(row), customerName: String(row.customer_name ?? ''), customerPhone: String(row.customer_phone ?? ''), customerEmail: String(row.customer_email ?? '') })
const notWaiting = () => new AppError(409, 'REFUND_NOT_OPEN', 'This refund request was already handled.')

async function lockCustomer(client: PoolClient, customerId: string): Promise<Row> {
  const { rows } = await client.query<Row>('select id, status, customer_type from customers where id = $1 for update', [customerId])
  if (!rows[0]) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'That customer does not exist.')
  return rows[0]
}

export function createWalletRepository(database: Database): WalletRepository {
  /** Fills in the PhonePe refunds sent for each request. */
  const withParts = async <T extends RefundRequest>(requests: T[], client: Pick<PoolClient, 'query'> = database): Promise<T[]> => {
    if (requests.length === 0) return requests
    const { rows } = await client.query<Row>(
      `select f.wallet_refund_request_id, f.payment_id, p.provider_reference as merchant_order_id, f.amount_paise, f.provider_reference, f.created_at
       from refunds f join payments p on p.id = f.payment_id where f.wallet_refund_request_id = any($1::uuid[]) order by f.created_at, f.id`,
      [requests.map(request => request.id)],
    )
    return requests.map(request => ({
      ...request,
      parts: rows.filter(row => String(row.wallet_refund_request_id) === request.id).map(row => ({
        paymentId: String(row.payment_id), merchantOrderId: String(row.merchant_order_id), amountPaise: Number(row.amount_paise), providerReference: String(row.provider_reference), createdAt: iso(row.created_at) as string,
      })),
    }))
  }
  const openRefund = async (customerId: string): Promise<RefundRequest | null> => {
    const { rows } = await database.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.customer_id = $1 and r.status = 'requested'`, [customerId])
    return rows[0] ? toRefund(rows[0]) : null
  }

  return {
    async summary(customerId) {
      const { rows } = await database.query<Row>('select customer_type, status from customers where id = $1', [customerId])
      const customer = rows[0]
      if (!customer) return null
      return { customerType: String(customer.customer_type), status: String(customer.status), balancePaise: await walletBalance(database, customerId), openRefund: await openRefund(customerId) }
    },

    async entries(customerId, page, pageSize) {
      const [{ rows }, { rows: count }] = await Promise.all([
        database.query<Row>(
          `select e.id, e.entry_type, e.direction, e.amount_paise, e.description, e.created_at, o.order_number
           from wallet_entries e left join orders o on o.id = e.order_id
           where e.customer_id = $1 order by e.created_at desc, e.id desc limit $2 offset $3`,
          [customerId, pageSize, (page - 1) * pageSize],
        ),
        database.query<Row>('select count(*)::int as total from wallet_entries where customer_id = $1', [customerId]),
      ])
      return {
        items: rows.map(row => ({
          id: String(row.id), type: row.entry_type as WalletEntryType, direction: row.direction as WalletDirection, amountPaise: Number(row.amount_paise),
          description: String(row.description ?? ''), orderNumber: row.order_number ? String(row.order_number) : null, createdAt: iso(row.created_at) as string,
        })),
        total: Number((count[0] as Row).total),
      }
    },

    async refunds(customerId) {
      const { rows } = await database.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.customer_id = $1 order by r.requested_at desc limit 20`, [customerId])
      return withParts(rows.map(toRefund))
    },

    createRefund: (customerId, input) => withTransaction(database, async client => {
      const { rows: earlier } = await client.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.customer_id = $1 and r.idempotency_key = $2`, [customerId, input.idempotencyKey])
      if (earlier[0]) return (await withParts([toRefund(earlier[0])], client))[0] as RefundRequest
      await lockCustomer(client, customerId)
      const { rows: open } = await client.query<Row>("select id from wallet_refund_requests where customer_id = $1 and status = 'requested'", [customerId])
      if (open[0]) throw new AppError(409, 'REFUND_ALREADY_REQUESTED', 'A refund is already on its way.')
      const balance = await walletBalance(client, customerId)
      if (balance <= 0) throw new AppError(409, 'WALLET_EMPTY', 'There is no money in your wallet to refund.')
      const { rows } = await client.query<Row>(
        `insert into wallet_refund_requests (customer_id, amount_paise, customer_note, idempotency_key) values ($1, $2, $3, $4)
         returning id, customer_id, amount_paise, status, customer_note, provider_reference, staff_note, requested_at, handled_at, completed_at`,
        [customerId, balance, input.note, input.idempotencyKey],
      )
      const request = toRefund(rows[0] as Row)
      await addWalletEntry(client, { customerId, type: 'refund_hold', direction: 'debit', amountPaise: balance, refundRequestId: request.id, description: 'Refund requested' })
      return request
    }),

    async adminRefunds({ status, page, pageSize }) {
      const values: unknown[] = []
      const where = status ? (values.push(status), `where r.status = $${values.length}`) : ''
      const [{ rows }, { rows: count }] = await Promise.all([
        database.query<Row>(
          `select ${REFUND_COLUMNS}, c.name as customer_name, coalesce(c.phone, '') as customer_phone, c.email as customer_email
           from wallet_refund_requests r join customers c on c.id = r.customer_id ${where}
           order by (r.status = 'requested') desc, r.requested_at desc limit $${values.length + 1} offset $${values.length + 2}`,
          [...values, pageSize, (page - 1) * pageSize],
        ),
        database.query<Row>(`select count(*)::int as total from wallet_refund_requests r ${where}`, values),
      ])
      return { items: await withParts(rows.map(toAdminRefund)), total: Number((count[0] as Row).total) }
    },

    async adminRefund(id) {
      const { rows } = await database.query<Row>(
        `select ${REFUND_COLUMNS}, c.name as customer_name, coalesce(c.phone, '') as customer_phone, c.email as customer_email
         from wallet_refund_requests r join customers c on c.id = r.customer_id where r.id = $1`,
        [id],
      )
      if (!rows[0]) return null
      const refund = (await withParts([toAdminRefund(rows[0])]))[0] as AdminRefundRow
      const { rows: payments } = await database.query<Row>(TOP_UP_SELECT, [refund.customerId])
      return { ...refund, topUps: payments.map(toTopUp) }
    },

    async walletCustomers({ search, show, page, pageSize }) {
      const values: unknown[] = []
      const conditions: string[] = []
      if (search) {
        values.push(likePattern(search))
        conditions.push(`(c.name ilike $${values.length} or coalesce(c.phone, '') ilike $${values.length} or c.email ilike $${values.length})`)
      }
      if (show === 'waiting') conditions.push('coalesce(req.waiting, 0) > 0')
      if (show === 'balance') conditions.push('per.balance > 0')
      const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
      const from = `from per join customers c on c.id = per.customer_id left join req on req.customer_id = per.customer_id ${where}`
      const [{ rows }, { rows: count }, { rows: overall }] = await Promise.all([
        database.query<Row>(
          `with ${TOTALS_CTE}
           select per.*, coalesce(req.refunded, 0) as refunded, coalesce(req.waiting, 0) as waiting, c.name, coalesce(c.phone, '') as phone, c.email, c.customer_type, c.status
           ${from} order by (coalesce(req.waiting, 0) > 0) desc, per.last_at desc, per.customer_id limit $${values.length + 1} offset $${values.length + 2}`,
          [...values, pageSize, (page - 1) * pageSize],
        ),
        database.query<Row>(`with ${TOTALS_CTE} select count(*)::int as total ${from}`, values),
        database.query<Row>(
          `with ${TOTALS_CTE} select
             coalesce(sum(per.balance) filter (where per.balance > 0), 0)::bigint as held, count(*) filter (where per.balance > 0)::int as holding,
             count(*) filter (where coalesce(req.waiting, 0) > 0)::int as waiting_count, coalesce(sum(req.waiting), 0)::bigint as waiting, coalesce(sum(req.refunded), 0)::bigint as refunded
           from per left join req on req.customer_id = per.customer_id`,
        ),
      ])
      const sums = overall[0] ?? {}
      return {
        items: rows.map(row => ({ ...toCustomer(row), ...toTotals(row), lastActivityAt: iso(row.last_at) as string })),
        total: Number((count[0] as Row).total),
        overview: { heldPaise: Number(sums.held ?? 0), customersHolding: Number(sums.holding ?? 0), waitingCount: Number(sums.waiting_count ?? 0), waitingPaise: Number(sums.waiting ?? 0), refundedPaise: Number(sums.refunded ?? 0) },
      }
    },

    async record(customerId) {
      const { rows: customers } = await database.query<Row>("select id, name, coalesce(phone, '') as phone, email, customer_type, status from customers where id = $1", [customerId])
      if (!customers[0]) return null
      const [{ rows: totals }, { rows: topUps }, { rows: requests }] = await Promise.all([
        database.query<Row>(`with ${TOTALS_CTE} select per.*, coalesce(req.refunded, 0) as refunded, coalesce(req.waiting, 0) as waiting from per left join req on req.customer_id = per.customer_id where per.customer_id = $1`, [customerId]),
        database.query<Row>(TOP_UP_SELECT, [customerId]),
        database.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.customer_id = $1 order by r.requested_at desc`, [customerId]),
      ])
      return { customer: toCustomer(customers[0]), totals: toTotals(totals[0] ?? {}), topUps: topUps.map(toTopUp), refunds: await withParts(requests.map(toRefund)) }
    },

    markSent: (id, input, adminId, now) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.id = $1 for update`, [id])
      if (!rows[0]) return null
      const request = toRefund(rows[0])
      if (request.status !== 'requested') throw notWaiting()
      const given = input.parts.reduce((sum, part) => sum + part.amountPaise, 0)
      if (given !== request.amountPaise) {
        throw new AppError(409, 'REFUND_PARTS_MISMATCH', `The refunds must add up to ${formatRupees(request.amountPaise)}.`, { expectedPaise: request.amountPaise, givenPaise: given })
      }
      // Payments are locked in one fixed order, so two staff saving at once can never block each other.
      for (const part of [...input.parts].sort((a, b) => a.paymentId.localeCompare(b.paymentId))) {
        const { rows: found } = await client.query<Row>(
          `select p.id, p.amount_paise, p.provider_reference, coalesce((select sum(f.amount_paise) from refunds f where f.payment_id = p.id), 0) as refunded_paise
           from payments p where p.id = $1 and p.customer_id = $2 and p.purpose = 'wallet_topup' and p.status in ('paid', 'partially_refunded') for update of p`,
          [part.paymentId, request.customerId],
        )
        const payment = found[0]
        if (!payment) throw new AppError(409, 'REFUND_PAYMENT_INVALID', 'One of the payments is not a wallet top-up of this customer that can still be refunded.', { paymentId: part.paymentId })
        const left = leftToRefund({ paymentId: part.paymentId, amountPaise: Number(payment.amount_paise), refundedPaise: Number(payment.refunded_paise) })
        if (part.amountPaise > left) {
          throw new AppError(409, 'REFUND_TOO_LARGE', `Only ${formatRupees(left)} is left to refund on payment ${String(payment.provider_reference)}.`, { paymentId: part.paymentId, leftPaise: left })
        }
        await client.query(
          'insert into refunds (payment_id, customer_id, amount_paise, reason, provider_reference, recorded_by, wallet_refund_request_id) values ($1, $2, $3, $4, $5, $6, $7)',
          [part.paymentId, request.customerId, part.amountPaise, input.note || 'Wallet refund', part.providerReference, adminId, id],
        )
        await client.query('update payments set status = $2, updated_at = now() where id = $1', [part.paymentId, part.amountPaise >= left ? 'refunded' : 'partially_refunded'])
      }
      const { rows: updated } = await client.query<Row>(
        `update wallet_refund_requests r set status = 'sent', provider_reference = $2, staff_note = $3, handled_by = $4, handled_at = $5 where r.id = $1 returning ${REFUND_COLUMNS}`,
        [id, input.parts.map(part => part.providerReference).join(', ').slice(0, 100), input.note, adminId, now],
      )
      return (await withParts([toRefund(updated[0] as Row)], client))[0] as RefundRequest
    }),

    cancelRefund: (id, note, adminId, now) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.id = $1 for update`, [id])
      if (!rows[0]) return null
      const request = toRefund(rows[0])
      if (request.status !== 'requested') throw notWaiting()
      const { rows: updated } = await client.query<Row>(
        `update wallet_refund_requests r set status = 'cancelled', staff_note = $2, handled_by = $3, handled_at = $4 where r.id = $1 returning ${REFUND_COLUMNS}`,
        [id, note, adminId, now],
      )
      await addWalletEntry(client, { customerId: request.customerId, type: 'refund_release', direction: 'credit', amountPaise: request.amountPaise, refundRequestId: id, description: 'Refund cancelled, money back in the wallet', createdBy: adminId })
      return (await withParts([toRefund(updated[0] as Row)], client))[0] as RefundRequest
    }),

    adjust: (customerId, input, adminId) => withTransaction(database, async client => {
      await lockCustomer(client, customerId)
      const balance = await walletBalance(client, customerId)
      if (input.direction === 'debit' && input.amountPaise > balance) throw new AppError(409, 'WALLET_BALANCE_LOW', 'The wallet does not have that much money.', { balancePaise: balance })
      await addWalletEntry(client, { customerId, type: 'manual_adjustment', direction: input.direction, amountPaise: input.amountPaise, description: input.reason, createdBy: adminId })
      return walletBalance(client, customerId)
    }),
  }
}
