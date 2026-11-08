import type { Database } from '../../db/pool.js'

/** What a delivered order needs to say about itself before it can earn a scratch card. */
export type RewardOrder = { customerId: string; orderNumber: string; totalPaise: number; status: string; fromPlan: boolean }

/** One scratch card as the customer app shows it. `code` stays null until the card is scratched. */
export type StoredRewardCard = {
  id: string; orderNumber: string; createdAt: string; expiresAt: string; scratchedAt: string | null; usedAt: string | null
  offer: {
    id: string; title: string; titleGu: string; description: string; descriptionGu: string; kind: 'percent' | 'flat' | 'free_gift'
    percent: number | null; flatPaise: number | null; maxDiscountPaise: number | null; minOrderPaise: number; endsOn: string | null
    showText: boolean; points: { en: string; gu: string }[]; imageKey: string | null; code: string | null
  }
}

export type RewardStats = { given: number; scratched: number; used: number }

/** Storage for scratch cards. The Postgres version below is the real one; tests use a fake. */
export interface RewardRepository {
  findOrder(orderId: string): Promise<RewardOrder | null>
  /** Live money-off offers in the scratch-card pool, with a code to reveal. */
  poolOfferIds(today: string): Promise<string[]>
  /** One card per order: a second call for the same order adds nothing and returns null. */
  create(card: { customerId: string; orderId: string; offerId: string; expiresAt: Date }): Promise<string | null>
  listForCustomer(customerId: string, limit: number): Promise<StoredRewardCard[]>
  /** Marks the card scratched (the first time only) and returns it, or null when it is not this customer's. */
  scratch(customerId: string, cardId: string, now: Date): Promise<StoredRewardCard | null>
  findForCustomer(customerId: string, cardId: string): Promise<StoredRewardCard | null>
  stats(): Promise<RewardStats>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const optionalIso = (value: unknown) => (value === null || value === undefined ? null : iso(value))
const optionalNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

// The code is read only for a scratched card, so an unscratched card can never leak it.
const COLUMNS = `r.id, o2.order_number, r.created_at, r.expires_at, r.scratched_at, r.used_at,
  o.id as offer_id, o.title, o.title_gu, o.description, o.description_gu, o.kind, o.percent, o.flat_paise, o.max_discount_paise, o.min_order_paise,
  to_char(o.ends_on, 'YYYY-MM-DD') as ends_on, o.show_text, o.points,
  (select m.object_key from media_assets m where m.id = o.image_asset_id and m.status = 'ready') as image_key,
  case when r.scratched_at is not null then o.code end as code`
const FROM = 'reward_cards r join offers o on o.id = r.offer_id join orders o2 on o2.id = r.order_id'

function toCard(row: Row): StoredRewardCard {
  return {
    id: String(row.id), orderNumber: String(row.order_number), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), scratchedAt: optionalIso(row.scratched_at), usedAt: optionalIso(row.used_at),
    offer: {
      id: String(row.offer_id), title: String(row.title), titleGu: String(row.title_gu), description: String(row.description), descriptionGu: String(row.description_gu),
      kind: row.kind as StoredRewardCard['offer']['kind'], percent: optionalNumber(row.percent), flatPaise: optionalNumber(row.flat_paise), maxDiscountPaise: optionalNumber(row.max_discount_paise),
      minOrderPaise: Number(row.min_order_paise), endsOn: row.ends_on ? String(row.ends_on) : null, showText: Boolean(row.show_text),
      points: Array.isArray(row.points) ? (row.points as { en?: unknown; gu?: unknown }[]).map(point => ({ en: String(point.en ?? ''), gu: String(point.gu ?? '') })) : [],
      imageKey: row.image_key ? String(row.image_key) : null, code: row.code ? String(row.code) : null,
    },
  }
}

export function createRewardRepository(database: Database): RewardRepository {
  async function findForCustomer(customerId: string, cardId: string): Promise<StoredRewardCard | null> {
    const { rows } = await database.query<Row>(`select ${COLUMNS} from ${FROM} where r.id = $1 and r.customer_id = $2`, [cardId, customerId])
    return rows[0] ? toCard(rows[0]) : null
  }

  return {
    async findOrder(orderId) {
      const { rows } = await database.query<Row>('select customer_id, order_number, total_paise, status, subscription_id from orders where id = $1', [orderId])
      const row = rows[0]
      return row ? { customerId: String(row.customer_id), orderNumber: String(row.order_number), totalPaise: Number(row.total_paise), status: String(row.status), fromPlan: row.subscription_id !== null } : null
    },
    async poolOfferIds(today) {
      const { rows } = await database.query<Row>(
        `select id from offers where in_reward_pool and status = 'active' and kind <> 'free_gift' and code is not null
           and (starts_on is null or starts_on <= $1::date) and (ends_on is null or ends_on >= $1::date) order by id`,
        [today],
      )
      return rows.map(row => String(row.id))
    },
    async create(card) {
      const { rows } = await database.query<Row>(
        'insert into reward_cards (customer_id, order_id, offer_id, expires_at) values ($1, $2, $3, $4) on conflict (order_id) do nothing returning id',
        [card.customerId, card.orderId, card.offerId, card.expiresAt],
      )
      return rows[0] ? String(rows[0].id) : null
    },
    async listForCustomer(customerId, limit) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from ${FROM} where r.customer_id = $1 order by r.created_at desc limit $2`, [customerId, limit])
      return rows.map(toCard)
    },
    async scratch(customerId, cardId, now) {
      const { rows } = await database.query<Row>('update reward_cards set scratched_at = coalesce(scratched_at, $3) where id = $1 and customer_id = $2 returning id', [cardId, customerId, now])
      return rows[0] ? findForCustomer(customerId, cardId) : null
    },
    findForCustomer,
    async stats() {
      const { rows } = await database.query<Row>('select count(*)::int as given, count(scratched_at)::int as scratched, count(used_at)::int as used from reward_cards')
      const row = rows[0] as Row
      return { given: Number(row.given), scratched: Number(row.scratched), used: Number(row.used) }
    },
  }
}
