import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { AppError } from '../../http/errors.js'
import { likePattern } from '../master-data/shared.js'
import type { AdjustmentListQuery, ApplyAdjustment, NewAdjustment } from './schema.js'

export type Adjustment = {
  id: string; customerId: string; customerName: string; customerPhone: string; orderId: string | null; orderNumber: string | null
  type: 'carry_forward' | 'account_credit' | 'refund_pending' | 'manual_adjustment'; status: 'pending' | 'applied' | 'cancelled'
  amountPaise: number | null; quantity: number | null; productName: string | null; variantName: string | null
  reason: string; effectiveDate: string; createdAt: string
}

/** Storage for what the business owes prepaid customers. The Postgres version below is the real one; tests use a fake. */
export interface AdjustmentRepository {
  list(query: AdjustmentListQuery): Promise<{ rows: Adjustment[]; total: number }>
  create(input: NewAdjustment, adminId: string, now: Date): Promise<Adjustment | null>
  /**
   * Marks a pending adjustment done. For a refund of a paid order, also records the refund against its payment and updates the
   * payment and order to refunded (or partly refunded). All or nothing. Returns null when there is no such adjustment.
   */
  apply(id: string, input: ApplyAdjustment, adminId: string): Promise<Adjustment | null>
  cancel(id: string): Promise<Adjustment | null>
}

type Row = Record<string, unknown>
const COLUMNS = `a.id, a.customer_id, c.name as customer_name, coalesce(c.phone, nullif(c.email, '')) as customer_phone, a.order_id, o.order_number, a.adjustment_type, a.status, a.amount_paise, a.quantity,
  p.name as product_name, v.name as variant_name, a.reason, to_char(a.effective_date, 'YYYY-MM-DD') as effective_date, a.created_at`
const FROM = 'prepaid_adjustments a join customers c on c.id = a.customer_id left join orders o on o.id = a.order_id left join products p on p.id = a.product_id left join product_variants v on v.id = a.variant_id'
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

const toAdjustment = (row: Row): Adjustment => ({
  id: String(row.id), customerId: String(row.customer_id), customerName: String(row.customer_name), customerPhone: row.customer_phone ? String(row.customer_phone) : '',
  orderId: row.order_id ? String(row.order_id) : null, orderNumber: row.order_number ? String(row.order_number) : null,
  type: row.adjustment_type as Adjustment['type'], status: row.status as Adjustment['status'], amountPaise: row.amount_paise === null ? null : Number(row.amount_paise),
  quantity: row.quantity === null ? null : Number(row.quantity), productName: row.product_name ? String(row.product_name) : null, variantName: row.variant_name ? String(row.variant_name) : null,
  reason: String(row.reason), effectiveDate: String(row.effective_date), createdAt: iso(row.created_at),
})

export function createAdjustmentRepository(database: Database): AdjustmentRepository {
  const find = async (id: string, query: Pick<Database, 'query'> = database): Promise<Adjustment | null> => {
    const { rows } = await query.query<Row>(`select ${COLUMNS} from ${FROM} where a.id = $1`, [id])
    return rows[0] ? toAdjustment(rows[0]) : null
  }

  return {
    async list({ search, status, type, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${COLUMNS}, count(*) over() as total from ${FROM}
         where ($1::text is null or a.status = $1) and ($2::text is null or a.adjustment_type = $2)
           and ($3::text is null or c.name ilike $3 or c.phone ilike $3 or c.email ilike $3 or o.order_number ilike $3)
         order by (a.status = 'pending') desc, a.created_at desc, a.id limit $4 offset $5`,
        [status ?? null, type ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toAdjustment), total: rows[0] ? Number(rows[0].total) : 0 }
    },

    async create({ customerId, type, amountPaise, reason }, adminId) {
      const { rows } = await database.query<Row>(
        `insert into prepaid_adjustments (customer_id, adjustment_type, status, amount_paise, reason, effective_date, dedupe_key, created_by)
         select c.id, $2::text, 'pending', $3::bigint, $4::text, (now() at time zone 'Asia/Kolkata')::date, 'manual:' || gen_random_uuid()::text, $5::uuid from customers c where c.id = $1 returning id`,
        [customerId, type, amountPaise, reason, adminId],
      )
      return rows[0] ? find(String((rows[0] as Row).id)) : null
    },

    apply: (id, { providerReference, note }, adminId) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>('select id, customer_id, order_id, payment_id, adjustment_type, status, amount_paise from prepaid_adjustments where id = $1 for update', [id])
      const adjustment = rows[0]
      if (!adjustment) return null
      if (adjustment.status !== 'pending') throw new AppError(409, 'ADJUSTMENT_NOT_PENDING', 'This adjustment is already done or cancelled.')
      if (adjustment.adjustment_type === 'refund_pending' && adjustment.amount_paise !== null) {
        // The payment being refunded: named on the adjustment (a payment whose order could not be placed), or the order's payment.
        let paymentId = adjustment.payment_id ?? null
        if (!paymentId && adjustment.order_id) {
          const { rows: orderRows } = await client.query<Row>('select payment_id from orders where id = $1 for update', [adjustment.order_id])
          paymentId = orderRows[0]?.payment_id ?? null
        }
        if (paymentId) {
          const amount = Number(adjustment.amount_paise)
          await client.query('select id from payments where id = $1 for update', [paymentId])
          await client.query('insert into refunds (payment_id, order_id, customer_id, amount_paise, reason, provider_reference, recorded_by) values ($1, $2, $3, $4, $5, $6, $7)', [paymentId, adjustment.order_id ?? null, adjustment.customer_id, amount, note, providerReference, adminId])
          const { rows: totals } = await client.query<Row>('select p.amount_paise as paid, coalesce(sum(r.amount_paise), 0) as refunded from payments p left join refunds r on r.payment_id = p.id where p.id = $1 group by p.amount_paise', [paymentId])
          const state = Number((totals[0] as Row).refunded) >= Number((totals[0] as Row).paid) ? 'refunded' : 'partially_refunded'
          await client.query('update payments set status = $2, updated_at = now() where id = $1', [paymentId, state])
          if (adjustment.order_id) await client.query('update orders set payment_status = $2, updated_at = now() where id = $1', [adjustment.order_id, state])
        }
      }
      await client.query("update prepaid_adjustments set status = 'applied', updated_at = now() where id = $1", [id])
      return find(id, client)
    }),

    async cancel(id) {
      const { rows } = await database.query<Row>("update prepaid_adjustments set status = 'cancelled', updated_at = now() where id = $1 and status = 'pending' returning id", [id])
      return rows[0] ? find(id) : null
    },
  }
}
