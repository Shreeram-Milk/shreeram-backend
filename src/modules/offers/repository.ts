import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import type { Offer } from './rules.js'
import type { OfferInput } from './schema.js'

/** What the admin sees of an offer: the offer, the gift's name, and when it changed. */
export type StoredOffer = Offer & { giftLabel: string | null; giftProductId: string | null; createdAt: string; updatedAt: string }

/** How many checkouts used an offer: in all, and by one customer. */
export type OfferUsage = { total: number; mine: number }

/** Storage for offers. The Postgres version below is the real one; tests use a fake. */
export interface OfferRepository {
  list(): Promise<StoredOffer[]>
  findById(id: string): Promise<StoredOffer | null>
  /** Active offers whose dates include `today`; the rules check the rest. */
  listLive(today: string): Promise<StoredOffer[]>
  findByCode(code: string): Promise<StoredOffer | null>
  create(input: OfferInput): Promise<StoredOffer>
  update(id: string, input: OfferInput): Promise<StoredOffer | null>
  setStatus(id: string, status: 'active' | 'inactive'): Promise<StoredOffer | null>
  /** Checkouts that used each offer (all customers, and this customer). A checkout counts once however many orders it made. */
  usage(offerIds: string[], customerId: string): Promise<Map<string, OfferUsage>>
  /** The price of a gift size (what the offer is worth), or null when that size is not on sale (switched off, or its product or category is). */
  giftPricePaise(variantId: string): Promise<number | null>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const optionalNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

const COLUMNS = `o.id, o.title, o.title_gu, o.description, o.description_gu, o.kind, o.percent, o.flat_paise, o.max_discount_paise, o.min_order_paise, o.scope,
  coalesce((select array_agg(op.product_id::text order by op.product_id) from offer_products op where op.offer_id = o.id), '{}') as product_ids,
  o.applies_one_time, o.applies_trial, o.applies_subscription, o.min_plan_days, o.gift_variant_id, o.gift_quantity, o.code,
  to_char(o.starts_on, 'YYYY-MM-DD') as starts_on, to_char(o.ends_on, 'YYYY-MM-DD') as ends_on, o.total_limit, o.per_customer_limit, o.status,
  (select p.name || ' - ' || v.name from product_variants v join products p on p.id = v.product_id where v.id = o.gift_variant_id) as gift_label,
  (select v.product_id from product_variants v where v.id = o.gift_variant_id) as gift_product_id,
  o.created_at, o.updated_at`

function toOffer(row: Row): StoredOffer {
  return {
    id: String(row.id), title: String(row.title), titleGu: String(row.title_gu), description: String(row.description), descriptionGu: String(row.description_gu),
    kind: row.kind as StoredOffer['kind'], percent: optionalNumber(row.percent), flatPaise: optionalNumber(row.flat_paise), maxDiscountPaise: optionalNumber(row.max_discount_paise),
    minOrderPaise: Number(row.min_order_paise), scope: row.scope as StoredOffer['scope'], productIds: (row.product_ids as string[]).map(String),
    appliesOneTime: Boolean(row.applies_one_time), appliesTrial: Boolean(row.applies_trial), appliesSubscription: Boolean(row.applies_subscription), minPlanDays: optionalNumber(row.min_plan_days),
    giftVariantId: row.gift_variant_id ? String(row.gift_variant_id) : null, giftQuantity: Number(row.gift_quantity), code: row.code ? String(row.code) : null,
    startsOn: row.starts_on ? String(row.starts_on) : null, endsOn: row.ends_on ? String(row.ends_on) : null, totalLimit: optionalNumber(row.total_limit), perCustomerLimit: optionalNumber(row.per_customer_limit),
    status: row.status as StoredOffer['status'], giftLabel: row.gift_label ? String(row.gift_label) : null, giftProductId: row.gift_product_id ? String(row.gift_product_id) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  }
}

const values = (input: OfferInput) => [
  input.title, input.titleGu, input.description, input.descriptionGu, input.kind, input.percent, input.flatPaise, input.maxDiscountPaise, input.minOrderPaise, input.scope,
  input.appliesOneTime, input.appliesTrial, input.appliesSubscription, input.minPlanDays, input.giftVariantId, input.giftQuantity, input.code, input.startsOn, input.endsOn,
  input.totalLimit, input.perCustomerLimit, input.status,
]

export function createOfferRepository(database: Database): OfferRepository {
  async function findById(id: string): Promise<StoredOffer | null> {
    const { rows } = await database.query<Row>(`select ${COLUMNS} from offers o where o.id = $1`, [id])
    return rows[0] ? toOffer(rows[0]) : null
  }

  return {
    async list() {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from offers o order by (o.status = 'active') desc, o.created_at desc`)
      return rows.map(toOffer)
    },
    findById,
    async listLive(today) {
      const { rows } = await database.query<Row>(
        `select ${COLUMNS} from offers o where o.status = 'active' and (o.starts_on is null or o.starts_on <= $1::date) and (o.ends_on is null or o.ends_on >= $1::date) order by o.created_at desc`,
        [today],
      )
      return rows.map(toOffer)
    },
    async findByCode(code) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from offers o where o.code = $1`, [code])
      return rows[0] ? toOffer(rows[0]) : null
    },
    create: input => withTransaction(database, async client => {
      const { rows } = await client.query<Row>(
        `insert into offers (title, title_gu, description, description_gu, kind, percent, flat_paise, max_discount_paise, min_order_paise, scope,
           applies_one_time, applies_trial, applies_subscription, min_plan_days, gift_variant_id, gift_quantity, code, starts_on, ends_on, total_limit, per_customer_limit, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) returning id`,
        values(input),
      )
      const id = String((rows[0] as Row).id)
      await client.query('insert into offer_products (offer_id, product_id) select $1, unnest($2::uuid[])', [id, input.productIds])
      const created = await client.query<Row>(`select ${COLUMNS} from offers o where o.id = $1`, [id])
      return toOffer(created.rows[0] as Row)
    }),
    update: (id, input) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>(
        `update offers set title = $2, title_gu = $3, description = $4, description_gu = $5, kind = $6, percent = $7, flat_paise = $8, max_discount_paise = $9, min_order_paise = $10, scope = $11,
           applies_one_time = $12, applies_trial = $13, applies_subscription = $14, min_plan_days = $15, gift_variant_id = $16, gift_quantity = $17, code = $18, starts_on = $19, ends_on = $20,
           total_limit = $21, per_customer_limit = $22, status = $23, updated_at = now() where id = $1 returning id`,
        [id, ...values(input)],
      )
      if (!rows[0]) return null
      await client.query('delete from offer_products where offer_id = $1', [id])
      await client.query('insert into offer_products (offer_id, product_id) select $1, unnest($2::uuid[])', [id, input.productIds])
      const updated = await client.query<Row>(`select ${COLUMNS} from offers o where o.id = $1`, [id])
      return toOffer(updated.rows[0] as Row)
    }),
    async setStatus(id, status) {
      const { rows } = await database.query<Row>('update offers set status = $2, updated_at = now() where id = $1 returning id', [id, status])
      return rows[0] ? findById(id) : null
    },
    async usage(offerIds, customerId) {
      const result = new Map<string, OfferUsage>(offerIds.map(id => [id, { total: 0, mine: 0 }]))
      if (offerIds.length === 0) return result
      const { rows } = await database.query<Row>(
        `select offer_id, count(distinct checkout_key)::int as total, count(distinct checkout_key) filter (where customer_id = $2)::int as mine
         from offer_redemptions where offer_id = any($1::uuid[]) group by offer_id`,
        [offerIds, customerId],
      )
      for (const row of rows) result.set(String(row.offer_id), { total: Number(row.total), mine: Number(row.mine) })
      return result
    },
    async giftPricePaise(variantId) {
      const { rows } = await database.query<Row>(
        `select v.price_paise from product_variants v join products p on p.id = v.product_id join categories c on c.id = p.category_id
         where v.id = $1 and v.status = 'active' and p.status = 'active' and c.status = 'active'`,
        [variantId],
      )
      return rows[0] ? Number(rows[0].price_paise) : null
    },
  }
}
