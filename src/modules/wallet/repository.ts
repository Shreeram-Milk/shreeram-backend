import type { PoolClient } from 'pg'
import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { AppError } from '../../http/errors.js'
import { addWalletEntry, walletBalance } from './ledger.js'
import type { RefundStatus, WalletDirection, WalletEntryType } from './rules.js'
import type { AdminRefundListQuery, WalletAdjustmentInput } from './schema.js'

type Row = Record<string, unknown>

export type WalletEntry = { id: string; type: WalletEntryType; direction: WalletDirection; amountPaise: number; description: string; orderNumber: string | null; createdAt: string }
export type RefundRequest = {
  id: string; customerId: string; amountPaise: number; status: RefundStatus; customerNote: string; providerReference: string; staffNote: string
  requestedAt: string; handledAt: string | null
}
export type WalletSummary = { customerType: string; status: string; balancePaise: number; openRefund: RefundRequest | null }
export type AdminRefundRow = RefundRequest & { customerName: string; customerPhone: string; customerEmail: string }
/** A PhonePe payment that added money: what staff refund against (PhonePe refunds always point at an original payment). */
export type TopUpPayment = { paymentId: string; merchantOrderId: string; transactionId: string | null; amountPaise: number; paidAt: string | null }

export interface WalletRepository {
  summary(customerId: string): Promise<WalletSummary | null>
  entries(customerId: string, page: number, pageSize: number): Promise<{ items: WalletEntry[]; total: number }>
  refunds(customerId: string): Promise<RefundRequest[]>
  /** Sets the whole balance aside for a refund. The same request key returns the same request. */
  createRefund(customerId: string, input: { note: string; idempotencyKey: string }): Promise<RefundRequest>
  adminRefunds(query: AdminRefundListQuery): Promise<{ items: AdminRefundRow[]; total: number }>
  adminRefund(id: string): Promise<(AdminRefundRow & { topUps: TopUpPayment[] }) | null>
  /** Null when there is no such request; refuses one that is no longer waiting. */
  markSent(id: string, input: { providerReference: string; note: string }, adminId: string, now: Date): Promise<RefundRequest | null>
  cancelRefund(id: string, note: string, adminId: string, now: Date): Promise<RefundRequest | null>
  /** Returns the new balance. */
  adjust(customerId: string, input: WalletAdjustmentInput, adminId: string): Promise<number>
}

const REFUND_COLUMNS = 'r.id, r.customer_id, r.amount_paise, r.status, r.customer_note, r.provider_reference, r.staff_note, r.requested_at, r.handled_at'
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString())
const toRefund = (row: Row): RefundRequest => ({
  id: String(row.id), customerId: String(row.customer_id), amountPaise: Number(row.amount_paise), status: row.status as RefundStatus,
  customerNote: String(row.customer_note ?? ''), providerReference: String(row.provider_reference ?? ''), staffNote: String(row.staff_note ?? ''),
  requestedAt: iso(row.requested_at) as string, handledAt: iso(row.handled_at),
})
const toAdminRefund = (row: Row): AdminRefundRow => ({ ...toRefund(row), customerName: String(row.customer_name ?? ''), customerPhone: String(row.customer_phone ?? ''), customerEmail: String(row.customer_email ?? '') })
const notWaiting = () => new AppError(409, 'REFUND_NOT_OPEN', 'This refund request was already handled.')

async function lockCustomer(client: PoolClient, customerId: string): Promise<Row> {
  const { rows } = await client.query<Row>('select id, status, customer_type from customers where id = $1 for update', [customerId])
  if (!rows[0]) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'That customer does not exist.')
  return rows[0]
}

export function createWalletRepository(database: Database): WalletRepository {
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
      const { rows } = await database.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.customer_id = $1 order by r.requested_at desc limit 10`, [customerId])
      return rows.map(toRefund)
    },

    createRefund: (customerId, input) => withTransaction(database, async client => {
      const { rows: earlier } = await client.query<Row>(`select ${REFUND_COLUMNS} from wallet_refund_requests r where r.customer_id = $1 and r.idempotency_key = $2`, [customerId, input.idempotencyKey])
      if (earlier[0]) return toRefund(earlier[0])
      await lockCustomer(client, customerId)
      const { rows: open } = await client.query<Row>("select id from wallet_refund_requests where customer_id = $1 and status = 'requested'", [customerId])
      if (open[0]) throw new AppError(409, 'REFUND_ALREADY_REQUESTED', 'A refund is already on its way.')
      const balance = await walletBalance(client, customerId)
      if (balance <= 0) throw new AppError(409, 'WALLET_EMPTY', 'There is no money in your wallet to refund.')
      const { rows } = await client.query<Row>(
        `insert into wallet_refund_requests (customer_id, amount_paise, customer_note, idempotency_key) values ($1, $2, $3, $4)
         returning id, customer_id, amount_paise, status, customer_note, provider_reference, staff_note, requested_at, handled_at`,
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
      return { items: rows.map(toAdminRefund), total: Number((count[0] as Row).total) }
    },

    async adminRefund(id) {
      const { rows } = await database.query<Row>(
        `select ${REFUND_COLUMNS}, c.name as customer_name, coalesce(c.phone, '') as customer_phone, c.email as customer_email
         from wallet_refund_requests r join customers c on c.id = r.customer_id where r.id = $1`,
        [id],
      )
      if (!rows[0]) return null
      const refund = toAdminRefund(rows[0])
      const { rows: payments } = await database.query<Row>(
        `select id, provider_reference, provider_transaction_id, amount_paise, paid_at from payments
         where customer_id = $1 and purpose = 'wallet_topup' and status in ('paid', 'partially_refunded') order by paid_at desc limit 20`,
        [refund.customerId],
      )
      return {
        ...refund,
        topUps: payments.map(row => ({ paymentId: String(row.id), merchantOrderId: String(row.provider_reference), transactionId: row.provider_transaction_id ? String(row.provider_transaction_id) : null, amountPaise: Number(row.amount_paise), paidAt: iso(row.paid_at) })),
      }
    },

    async markSent(id, input, adminId, now) {
      const { rows } = await database.query<Row>(
        `update wallet_refund_requests r set status = 'sent', provider_reference = $2, staff_note = $3, handled_by = $4, handled_at = $5
         where r.id = $1 and r.status = 'requested' returning ${REFUND_COLUMNS}`,
        [id, input.providerReference, input.note, adminId, now],
      )
      if (rows[0]) return toRefund(rows[0])
      const { rows: exists } = await database.query<Row>('select 1 from wallet_refund_requests where id = $1', [id])
      if (exists[0]) throw notWaiting()
      return null
    },

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
      return toRefund(updated[0] as Row)
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
