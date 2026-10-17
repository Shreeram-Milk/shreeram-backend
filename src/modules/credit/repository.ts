import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { AppError } from '../../http/errors.js'
import { likePattern } from '../master-data/shared.js'

/** Whole-rupee text for an error message, e.g. 37500 -> ₹375. */
const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
import type { AdjustmentInput, CreditAccountListQuery, LedgerQuery, PaymentRequestInput, RecordPaymentInput } from './schema.js'

export type CreditAccount = {
  customerId: string; name: string; phone: string; customerType: 'prepaid' | 'credit'; status: 'active' | 'blocked' | 'deleted'
  limitPaise: number; owedPaise: number; remainingPaise: number; lastPaymentAt: string | null
}
export type LedgerEntry = {
  id: string; entryType: 'order_charge' | 'payment_received' | 'order_refund' | 'manual_adjustment' | 'opening_balance'; direction: 'debit' | 'credit'; amountPaise: number
  orderId: string | null; orderNumber: string | null; paymentId: string | null; description: string; occurredOn: string; createdAt: string
  /** What the customer owed right after this entry. */
  balancePaise: number
}
export type PaymentRequest = { id: string; customerId: string; amountPaise: number; note: string; status: 'open' | 'paid' | 'cancelled'; createdAt: string; closedAt: string | null }

/** Storage for credit accounts. The Postgres version below is the real one; tests use a fake. */
export interface CreditRepository {
  listAccounts(query: CreditAccountListQuery): Promise<{ rows: CreditAccount[]; total: number }>
  getAccount(customerId: string): Promise<CreditAccount | null>
  ledger(customerId: string, query: LedgerQuery): Promise<{ rows: LedgerEntry[]; total: number }>
  setLimit(customerId: string, limitPaise: number): Promise<CreditAccount | null>
  /** Records money handed over by hand, as one all-or-nothing step: the payment, the ledger credit and (optionally) closing its request. */
  recordPayment(customerId: string, input: RecordPaymentInput, adminId: string, now: Date): Promise<CreditAccount>
  addAdjustment(customerId: string, input: AdjustmentInput, adminId: string): Promise<CreditAccount>
  createRequest(customerId: string, input: PaymentRequestInput, adminId: string): Promise<PaymentRequest>
  listOpenRequests(customerId: string): Promise<PaymentRequest[]>
  cancelRequest(customerId: string, requestId: string, now: Date): Promise<PaymentRequest | null>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const OWED = "coalesce((select sum(case when l.direction = 'debit' then l.amount_paise else -l.amount_paise end) from credit_ledger_entries l where l.customer_id = c.id), 0)"
const LAST_PAYMENT = "(select max(l.created_at) from credit_ledger_entries l where l.customer_id = c.id and l.entry_type = 'payment_received')"
const ACCOUNT_COLUMNS = `c.id, c.name, coalesce(c.phone, nullif(c.email, '')) as phone, c.customer_type, c.status, c.credit_limit_paise, ${OWED} as owed, ${LAST_PAYMENT} as last_payment`

const toAccount = (row: Row): CreditAccount => {
  const limit = Number(row.credit_limit_paise)
  const owed = Number(row.owed)
  return {
    customerId: String(row.id), name: String(row.name), phone: row.phone ? String(row.phone) : '', customerType: row.customer_type as CreditAccount['customerType'], status: row.status as CreditAccount['status'],
    limitPaise: limit, owedPaise: owed, remainingPaise: Math.max(0, limit - owed), lastPaymentAt: row.last_payment ? iso(row.last_payment) : null,
  }
}
const toRequest = (row: Row): PaymentRequest => ({ id: String(row.id), customerId: String(row.customer_id), amountPaise: Number(row.amount_paise), note: String(row.note), status: row.status as PaymentRequest['status'], createdAt: iso(row.created_at), closedAt: row.closed_at ? iso(row.closed_at) : null })

export function createCreditRepository(database: Database): CreditRepository {
  async function account(customerId: string, query: Pick<Database, 'query'> = database): Promise<CreditAccount | null> {
    const { rows } = await query.query<Row>(`select ${ACCOUNT_COLUMNS} from customers c where c.id = $1`, [customerId])
    return rows[0] ? toAccount(rows[0]) : null
  }
  /** Locks the customer's row so two money changes for one customer cannot run at the same moment, and returns what they owe. */
  async function lockAndOwed(client: Pick<Database, 'query'>, customerId: string): Promise<number> {
    const { rows } = await client.query<Row>(`select ${OWED} as owed from customers c where c.id = $1 for update`, [customerId])
    if (!rows[0]) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'That customer does not exist.')
    return Number(rows[0].owed)
  }

  return {
    async listAccounts({ search, owingOnly, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `with a as (select ${ACCOUNT_COLUMNS} from customers c where c.customer_type = 'credit' and c.status <> 'deleted' and ($1::text is null or c.name ilike $1 or c.phone ilike $1 or c.email ilike $1))
         select *, count(*) over() as total from a where (not $2::boolean or owed > 0) order by owed desc, name, id limit $3 offset $4`,
        [search ? likePattern(search) : null, owingOnly, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toAccount), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    getAccount: customerId => account(customerId),

    async ledger(customerId, { page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select * from (
           select l.id, l.entry_type, l.direction, l.amount_paise, l.order_id, o.order_number, l.payment_id, l.description, to_char(l.occurred_on, 'YYYY-MM-DD') as occurred_on, l.created_at,
                  sum(case when l.direction = 'debit' then l.amount_paise else -l.amount_paise end) over (order by l.created_at, l.id) as balance, count(*) over() as total
           from credit_ledger_entries l left join orders o on o.id = l.order_id where l.customer_id = $1
         ) t order by created_at desc, id desc limit $2 offset $3`,
        [customerId, pageSize, (page - 1) * pageSize],
      )
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        rows: rows.map((row): LedgerEntry => ({
          id: String(row.id), entryType: row.entry_type as LedgerEntry['entryType'], direction: row.direction as LedgerEntry['direction'], amountPaise: Number(row.amount_paise),
          orderId: row.order_id ? String(row.order_id) : null, orderNumber: row.order_number ? String(row.order_number) : null, paymentId: row.payment_id ? String(row.payment_id) : null,
          description: String(row.description), occurredOn: String(row.occurred_on), createdAt: iso(row.created_at), balancePaise: Number(row.balance),
        })),
      }
    },

    async setLimit(customerId, limitPaise) {
      const { rows } = await database.query<Row>("update customers set credit_limit_paise = $2, updated_at = now() where id = $1 and customer_type = 'credit' returning id", [customerId, limitPaise])
      return rows[0] ? account(customerId) : null
    },

    recordPayment: (customerId, { amountPaise, method, note, paymentRequestId }, adminId, now) => withTransaction(database, async client => {
      const owed = await lockAndOwed(client, customerId)
      if (amountPaise > owed) throw new AppError(409, 'PAYMENT_EXCEEDS_BALANCE', `That is more than the customer owes right now (${rupees(owed)}).`, { owedPaise: owed })
      const { rows } = await client.query<Row>(
        "insert into payments (customer_id, purpose, method, amount_paise, status, note, recorded_by, paid_at) values ($1, 'credit_settlement', $2, $3, 'paid', $4, $5, $6) returning id",
        [customerId, method, amountPaise, note, adminId, now],
      )
      const paymentId = String((rows[0] as Row).id)
      await client.query(
        "insert into credit_ledger_entries (customer_id, entry_type, direction, amount_paise, payment_id, description, created_by, occurred_on, created_at) values ($1, 'payment_received', 'credit', $2, $3, $4, $5, (now() at time zone 'Asia/Kolkata')::date, clock_timestamp())",
        [customerId, amountPaise, paymentId, note || `Payment received (${method.replaceAll('_', ' ')})`, adminId],
      )
      if (paymentRequestId) {
        await client.query("update payment_requests set status = 'paid', payment_id = $3, closed_at = $4 where id = $1 and customer_id = $2 and status = 'open'", [paymentRequestId, customerId, paymentId, now])
      }
      return (await account(customerId, client)) as CreditAccount
    }),

    addAdjustment: (customerId, { direction, amountPaise, description }, adminId) => withTransaction(database, async client => {
      const owed = await lockAndOwed(client, customerId)
      // A credit adjustment lowers what is owed; it must not push it below zero (that would be money the business owes, which is a refund, not credit).
      if (direction === 'credit' && amountPaise > owed) throw new AppError(409, 'ADJUSTMENT_EXCEEDS_BALANCE', `That is more than the customer owes right now (${rupees(owed)}).`, { owedPaise: owed })
      await client.query(
        "insert into credit_ledger_entries (customer_id, entry_type, direction, amount_paise, description, created_by, occurred_on, created_at) values ($1, 'manual_adjustment', $2, $3, $4, $5, (now() at time zone 'Asia/Kolkata')::date, clock_timestamp())",
        [customerId, direction, amountPaise, description, adminId],
      )
      return (await account(customerId, client)) as CreditAccount
    }),

    async createRequest(customerId, { amountPaise, note }, adminId) {
      const { rows } = await database.query<Row>('insert into payment_requests (customer_id, amount_paise, note, created_by) values ($1, $2, $3, $4) returning id, customer_id, amount_paise, note, status, created_at, closed_at', [customerId, amountPaise, note, adminId])
      return toRequest(rows[0] as Row)
    },
    async listOpenRequests(customerId) {
      const { rows } = await database.query<Row>("select id, customer_id, amount_paise, note, status, created_at, closed_at from payment_requests where customer_id = $1 and status = 'open' order by created_at desc", [customerId])
      return rows.map(toRequest)
    },
    async cancelRequest(customerId, requestId, now) {
      const { rows } = await database.query<Row>("update payment_requests set status = 'cancelled', closed_at = $3 where id = $1 and customer_id = $2 and status = 'open' returning id, customer_id, amount_paise, note, status, created_at, closed_at", [requestId, customerId, now])
      return rows[0] ? toRequest(rows[0]) : null
    },

  }
}
