import type { PoolClient } from 'pg'
import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { AppError } from '../../http/errors.js'
import { likePattern } from '../master-data/shared.js'
import { lockOffer } from '../offers/redemption.js'
import { insertOrders, type NewOrder } from '../orders/repository.js'
import type { OrderStatus } from '../orders/rules.js'
import { overlapsPause, type Pause, type ScheduleType } from './rules.js'
import type { AdminSubscriptionListQuery } from './schema.js'

export type SubscriptionKind = 'subscription' | 'trial'
export type SubscriptionStatus = 'active' | 'completed' | 'cancelled'
export type SkipReason = 'customer' | 'admin' | 'order_cancelled' | 'credit_limit' | 'not_deliverable'

/** The free product of a subscription offer: sent with the first delivery that goes out. */
export type SubscriptionGift = {
  variantId: string; productId: string; productName: string; productNameGu: string; variantName: string; quantity: number
  includeInProductionPlanning: boolean; productionUnit: string; productionQuantity: number
}
export type SubscriptionAddress = { recipientName: string; recipientPhone: string; addressLine1: string; addressLine2: string; landmark: string; city: string; pinCode: string; doorstepNote: string }
export type SubscriptionLine = { id: string; slotId: string; slotName: string; startTime: string; endTime: string; quantity: number }
export type StoredPause = Pause & { id: string }
export type StoredSkip = { lineId: string; date: string; reason: SkipReason }
/** An order made for one delivery of this subscription. */
export type SubscriptionDelivery = { orderId: string; orderNumber: string; lineId: string; date: string; status: OrderStatus }

export type SubscriptionRecord = {
  id: string; number: string; customerId: string; customerName: string; customerPhone: string; kind: SubscriptionKind
  productId: string; variantId: string; productName: string; productNameGu: string; variantName: string; unitPricePaise: number
  includeInProductionPlanning: boolean; productionUnit: string; productionQuantity: number
  ruleId: string | null; trialPlanId: string | null; planName: string; scheduleType: ScheduleType; weekdays: number[]; deliveriesPerLine: number; startDate: string
  address: SubscriptionAddress
  paymentMethod: 'credit' | 'online'; paymentId: string | null; totalPaise: number
  /** The offer the plan started with ('' when none): the money it took off, spread over the deliveries, and the free gift. */
  offerTitle: string; offerTitleGu: string; discountPaise: number; gift: SubscriptionGift | null
  status: SubscriptionStatus; cancelledAt: string | null; cancelReason: string; createdAt: string
  lines: SubscriptionLine[]; pauses: StoredPause[]; skips: StoredSkip[]; deliveries: SubscriptionDelivery[]
}

/** Everything needed to write a new subscription. The service has checked and priced it. */
export type SubscriptionDraft = {
  customerId: string; kind: SubscriptionKind; productId: string; variantId: string; productName: string; productNameGu: string; variantName: string; unitPricePaise: number
  includeInProductionPlanning: boolean; productionUnit: string; productionQuantity: number
  ruleId: string | null; trialPlanId: string | null; planName: string; scheduleType: ScheduleType; weekdays: number[]; deliveriesPerLine: number; startDate: string
  address: SubscriptionAddress; paymentMethod: 'credit' | 'online'; totalPaise: number; idempotencyKey: string | null
  /** The offer used. `totalPaise` is already net of its discount. */
  offer: { id: string; title: string; titleGu: string; discountPaise: number; gift: SubscriptionGift | null } | null
  lines: Array<{ slotId: string; slotName: string; startTime: string; endTime: string; quantity: number }>
}

/** What a product offers for subscribing: its live subscription rules (with length options) and trial plans. */
export type ProductPlans = {
  productId: string; status: string; purchaseMethods: string[]; deliveryMethod: string | null; excludedFromCredit: boolean
  rules: Array<{ id: string; name: string; systemType: ScheduleType; lengthOptions: number[]; minDays: number; maxDays: number }>
  trialPlans: Array<{ id: string; name: string; durationDays: number }>
}

export type SubscriptionActivity = { kind: string; detail: Record<string, unknown>; createdAt: string; byStaff: boolean }
/** `nextDelivery`: the nearest delivery whose order is made and still on its way (orders are made a few days ahead). */
export type AdminSubscriptionRow = Omit<SubscriptionRecord, 'pauses' | 'skips' | 'deliveries'> & { paused: boolean; usedDeliveries: number; deliveredDeliveries: number; alerts: number; nextDelivery: { date: string; slotName: string } | null }
/** How many subscriptions are in each list state ("paused" = active with a pause covering today), for the status tabs. */
export type SubscriptionStateCounts = { active: number; paused: number; completed: number; cancelled: number }
export type SubscriptionAlert = { subscriptionId: string; subscriptionNumber: string; customerName: string; date: string; slotName: string; reason: SkipReason; createdAt: string }

/** How creating one delivery's order went. */
export type DeliveryOutcome = 'created' | 'exists' | 'skipped' | 'paused' | 'inactive' | 'credit_limit' | 'customer_inactive'

/** Storage for subscriptions. The Postgres version below is the real one; tests use a fake. */
export interface SubscriptionRepository {
  productPlans(productId: string): Promise<ProductPlans | null>
  /** Has this customer ever had a trial of this product (any trial that was paid or started)? */
  hasTrial(customerId: string, productId: string): Promise<boolean>
  findIdByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<string | null>
  /** Writes a subscription that needs no upfront payment (credit). Online ones are written by the payment step. */
  create(draft: SubscriptionDraft): Promise<string>
  find(id: string): Promise<SubscriptionRecord | null>
  listForCustomer(customerId: string): Promise<SubscriptionRecord[]>
  /** Active subscriptions in id order after `afterId`, for the delivery job. */
  listActive(afterId: string | null, limit: number): Promise<SubscriptionRecord[]>
  addSkip(subscriptionId: string, lineId: string, date: string, reason: SkipReason): Promise<boolean>
  /** Removes a skip the customer or staff made (never one the system made). */
  removeSkip(subscriptionId: string, lineId: string, date: string): Promise<boolean>
  /** Removes the skips that cancelling orders for a pause recorded (never the system's credit-limit or not-deliverable ones). */
  clearSkips(subscriptionId: string, days: Array<{ lineId: string; date: string }>): Promise<void>
  /** Adds a pause, refusing one that overlaps an earlier pause. Under a lock on the subscription. */
  addPause(subscriptionId: string, pause: Pause, adminId: string | null): Promise<void>
  /** Ends the open or covering pause so deliveries start again on `fromDate`. False when nothing was paused then. */
  resume(subscriptionId: string, fromDate: string): Promise<boolean>
  /**
   * Writes the order for one delivery, re-checking under a lock that the subscription is still active and the day is still
   * a delivery (not skipped, not paused, no order yet). A credit customer over the limit gets the day skipped instead.
   */
  createDelivery(input: { subscriptionId: string; lineId: string; date: string; order: Omit<NewOrder, 'idempotencyKey'> }, now: Date): Promise<DeliveryOutcome>
  /**
   * Makes sure a plan's free gift is on an order that will still go out. If the order that carried it was skipped or cancelled, the gift moves
   * to the next delivery not yet on its way. Does nothing when the plan has no gift, or its gift is already on a live order.
   */
  ensureGiftCarrier(subscriptionId: string): Promise<void>
  complete(subscriptionId: string): Promise<void>
  /** Marks it cancelled (stopping new deliveries) under the lock. False when it was not active. */
  markCancelled(subscriptionId: string, reason: string, now: Date): Promise<boolean>
  /** The "refund to send" item for an online-paid subscription cancelled with deliveries unused. Once per subscription. */
  recordCancelRefund(subscriptionId: string, amountPaise: number, adminId: string | null): Promise<void>
  addActivity(subscriptionId: string, kind: string, detail?: Record<string, unknown>, adminId?: string | null): Promise<void>
  activity(subscriptionId: string): Promise<SubscriptionActivity[]>
  adminList(query: AdminSubscriptionListQuery, today: string): Promise<{ rows: AdminSubscriptionRow[]; total: number; counts: SubscriptionStateCounts; alerts: SubscriptionAlert[] }>
}

type Row = Record<string, unknown>

/**
 * The windows of some subscriptions, with each slot's name and times as they are NOW (renaming a slot in the admin changes it
 * everywhere at once). What was saved when the subscription started is only a fallback.
 */
const LINES_SQL = `select l.id, l.subscription_id, l.delivery_slot_id, coalesce(ds.name, l.slot_name) as slot_name,
    to_char(coalesce(ds.start_time, l.slot_start_time), 'HH24:MI') as start_time, to_char(coalesce(ds.end_time, l.slot_end_time), 'HH24:MI') as end_time, l.quantity
  from subscription_lines l left join delivery_slots ds on ds.id = l.delivery_slot_id
  where l.subscription_id = any($1::uuid[]) order by coalesce(ds.start_time, l.slot_start_time)`
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

const SUBSCRIPTION_COLUMNS = `s.id, s.subscription_number, s.customer_id, c.name as customer_name, coalesce(c.phone, nullif(c.email, '')) as customer_phone, s.kind, s.product_id, s.variant_id, s.product_name, s.product_name_gu,
  s.variant_name, s.unit_price_paise, s.include_in_production_planning, s.production_unit, s.production_quantity, s.subscription_rule_id, s.trial_plan_id, s.plan_name,
  s.schedule_type, s.weekdays, s.deliveries_per_line, to_char(s.start_date, 'YYYY-MM-DD') as start_date,
  s.recipient_name, s.recipient_phone, s.address_line1, s.address_line2, s.landmark, s.city, s.pin_code, s.doorstep_note,
  s.payment_method, s.payment_id, s.total_paise, s.offer_title, s.offer_title_gu, s.discount_paise, s.gift, s.status, s.cancelled_at, s.cancel_reason, s.created_at`

const toBase = (row: Row): Omit<SubscriptionRecord, 'lines' | 'pauses' | 'skips' | 'deliveries'> => ({
  id: String(row.id), number: String(row.subscription_number), customerId: String(row.customer_id), customerName: String(row.customer_name ?? ''), customerPhone: String(row.customer_phone ?? ''),
  kind: row.kind as SubscriptionKind, productId: String(row.product_id), variantId: String(row.variant_id), productName: String(row.product_name), productNameGu: String(row.product_name_gu),
  variantName: String(row.variant_name), unitPricePaise: Number(row.unit_price_paise), includeInProductionPlanning: Boolean(row.include_in_production_planning),
  productionUnit: String(row.production_unit), productionQuantity: Number(row.production_quantity),
  ruleId: row.subscription_rule_id ? String(row.subscription_rule_id) : null, trialPlanId: row.trial_plan_id ? String(row.trial_plan_id) : null, planName: String(row.plan_name),
  scheduleType: row.schedule_type as ScheduleType, weekdays: ((row.weekdays as number[] | null) ?? []).map(Number), deliveriesPerLine: Number(row.deliveries_per_line), startDate: String(row.start_date),
  address: {
    recipientName: String(row.recipient_name), recipientPhone: String(row.recipient_phone), addressLine1: String(row.address_line1), addressLine2: String(row.address_line2),
    landmark: String(row.landmark), city: String(row.city), pinCode: String(row.pin_code), doorstepNote: String(row.doorstep_note),
  },
  paymentMethod: row.payment_method as 'credit' | 'online', paymentId: row.payment_id ? String(row.payment_id) : null, totalPaise: Number(row.total_paise),
  offerTitle: String(row.offer_title ?? ''), offerTitleGu: String(row.offer_title_gu ?? ''), discountPaise: Number(row.discount_paise ?? 0), gift: (row.gift as SubscriptionGift | null) ?? null,
  status: row.status as SubscriptionStatus, cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null, cancelReason: String(row.cancel_reason), createdAt: iso(row.created_at),
})

/** Writes a subscription and its slot lines inside the caller's transaction. Used directly by the payment step for online ones. */
export async function insertSubscription(client: Pick<PoolClient, 'query'>, draft: SubscriptionDraft, paymentId: string | null): Promise<string> {
  const { rows } = await client.query<Row>(
    `insert into subscriptions (customer_id, kind, product_id, variant_id, product_name, product_name_gu, variant_name, unit_price_paise, include_in_production_planning, production_unit, production_quantity,
       subscription_rule_id, trial_plan_id, plan_name, schedule_type, weekdays, deliveries_per_line, start_date,
       recipient_name, recipient_phone, address_line1, address_line2, landmark, city, pin_code, doorstep_note, payment_method, payment_id, total_paise, idempotency_key,
       offer_id, offer_title, offer_title_gu, discount_paise, gift)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::smallint[], $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35::jsonb) returning id`,
    [draft.customerId, draft.kind, draft.productId, draft.variantId, draft.productName, draft.productNameGu, draft.variantName, draft.unitPricePaise, draft.includeInProductionPlanning, draft.productionUnit, draft.productionQuantity,
      draft.ruleId, draft.trialPlanId, draft.planName, draft.scheduleType, draft.weekdays, draft.deliveriesPerLine, draft.startDate,
      draft.address.recipientName, draft.address.recipientPhone, draft.address.addressLine1, draft.address.addressLine2, draft.address.landmark, draft.address.city, draft.address.pinCode, draft.address.doorstepNote,
      draft.paymentMethod, paymentId, draft.totalPaise, draft.idempotencyKey,
      draft.offer?.id ?? null, draft.offer?.title ?? '', draft.offer?.titleGu ?? '', draft.offer?.discountPaise ?? 0, draft.offer?.gift ? JSON.stringify(draft.offer.gift) : null],
  )
  const id = String((rows[0] as Row).id)
  if (draft.offer) {
    // Counted once, under a lock on the offer, in the same transaction that starts the plan.
    const checkoutKey = `sub:${id}`
    await lockOffer(client, draft.customerId, { id: draft.offer.id, checkoutKey })
    await client.query('insert into offer_redemptions (offer_id, customer_id, checkout_key, subscription_id, discount_paise) values ($1, $2, $3, $4, $5)', [draft.offer.id, draft.customerId, checkoutKey, id, draft.offer.discountPaise])
  }
  await client.query(
    `insert into subscription_lines (subscription_id, delivery_slot_id, slot_name, slot_start_time, slot_end_time, quantity)
     select $1, l.slot_id, l.slot_name, l.start_time::time, l.end_time::time, l.quantity from jsonb_to_recordset($2::jsonb) as l(slot_id uuid, slot_name text, start_time text, end_time text, quantity integer)`,
    [id, JSON.stringify(draft.lines.map(line => ({ slot_id: line.slotId, slot_name: line.slotName, start_time: line.startTime, end_time: line.endTime, quantity: line.quantity })))],
  )
  await client.query('insert into subscription_activity (subscription_id, kind, detail) values ($1, $2, $3::jsonb)', [id, 'started', JSON.stringify({ paymentMethod: draft.paymentMethod, totalPaise: draft.totalPaise })])
  return id
}

export function createSubscriptionRepository(database: Database): SubscriptionRepository {
  /** Loads full records (lines, pauses, skips, delivery orders) for the given subscription rows, in four queries in all. */
  async function withDetails(rows: Row[], client: Pick<PoolClient, 'query'> = database): Promise<SubscriptionRecord[]> {
    if (rows.length === 0) return []
    const ids = rows.map(row => String(row.id))
    const [lines, pauses, skips, orders] = await Promise.all([
      client.query<Row>(LINES_SQL, [ids]),
      client.query<Row>("select id, subscription_id, to_char(from_date, 'YYYY-MM-DD') as from_date, to_char(until_date, 'YYYY-MM-DD') as until_date from subscription_pauses where subscription_id = any($1::uuid[]) order by from_date", [ids]),
      client.query<Row>("select subscription_id, subscription_line_id, to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, reason from subscription_skips where subscription_id = any($1::uuid[]) order by delivery_date", [ids]),
      client.query<Row>("select id, order_number, subscription_id, subscription_line_id, to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, status from orders where subscription_id = any($1::uuid[]) order by delivery_date, order_number", [ids]),
    ])
    return rows.map(row => {
      const id = String(row.id)
      return {
        ...toBase(row),
        lines: lines.rows.filter(line => String(line.subscription_id) === id).map(line => ({ id: String(line.id), slotId: String(line.delivery_slot_id), slotName: String(line.slot_name), startTime: String(line.start_time), endTime: String(line.end_time), quantity: Number(line.quantity) })),
        pauses: pauses.rows.filter(pause => String(pause.subscription_id) === id).map(pause => ({ id: String(pause.id), fromDate: String(pause.from_date), untilDate: pause.until_date ? String(pause.until_date) : null })),
        skips: skips.rows.filter(skip => String(skip.subscription_id) === id).map(skip => ({ lineId: String(skip.subscription_line_id), date: String(skip.delivery_date), reason: skip.reason as SkipReason })),
        deliveries: orders.rows.filter(order => String(order.subscription_id) === id).map(order => ({ orderId: String(order.id), orderNumber: String(order.order_number), lineId: String(order.subscription_line_id), date: String(order.delivery_date), status: order.status as OrderStatus })),
      }
    })
  }

  const FROM = 'from subscriptions s join customers c on c.id = s.customer_id'
  /** Locks one subscription for a change; its status, or null when it does not exist. */
  const lock = async (client: PoolClient, id: string): Promise<SubscriptionStatus | null> => {
    const { rows } = await client.query<Row>('select status from subscriptions where id = $1 for update', [id])
    return rows[0] ? (rows[0].status as SubscriptionStatus) : null
  }
  const activityIn = (client: Pick<PoolClient, 'query'>, id: string, kind: string, detail: Record<string, unknown> = {}, adminId: string | null = null) =>
    client.query('insert into subscription_activity (subscription_id, kind, detail, created_by) values ($1, $2, $3::jsonb, $4)', [id, kind, JSON.stringify(detail), adminId])

  return {
    async productPlans(productId) {
      const { rows } = await database.query<Row>('select id, status, purchase_methods, delivery_method, excluded_from_credit from products where id = $1', [productId])
      const product = rows[0]
      if (!product) return null
      const [rules, trials] = await Promise.all([
        database.query<Row>("select r.id, r.name, r.system_type, r.length_options, r.min_days, r.max_days from product_subscription_rules l join subscription_rules r on r.id = l.subscription_rule_id and r.status = 'active' where l.product_id = $1 order by r.name", [productId]),
        database.query<Row>("select t.id, t.name, t.duration_days from product_trial_plans l join trial_plans t on t.id = l.trial_plan_id and t.status = 'active' where l.product_id = $1 order by t.duration_days", [productId]),
      ])
      return {
        productId, status: String(product.status), purchaseMethods: ((product.purchase_methods as string[] | null) ?? []).map(String), deliveryMethod: product.delivery_method ? String(product.delivery_method) : null,
        excludedFromCredit: Boolean(product.excluded_from_credit),
        rules: rules.rows.map(rule => ({ id: String(rule.id), name: String(rule.name), systemType: rule.system_type as ScheduleType, lengthOptions: ((rule.length_options as number[] | null) ?? []).map(Number), minDays: Number(rule.min_days), maxDays: Number(rule.max_days) })),
        trialPlans: trials.rows.map(plan => ({ id: String(plan.id), name: String(plan.name), durationDays: Number(plan.duration_days) })),
      }
    },

    async hasTrial(customerId, productId) {
      const { rows } = await database.query<Row>("select 1 from subscriptions where customer_id = $1 and product_id = $2 and kind = 'trial' and status = 'active' limit 1", [customerId, productId])
      return rows.length > 0
    },

    async findIdByIdempotencyKey(customerId, idempotencyKey) {
      const { rows } = await database.query<Row>('select id from subscriptions where customer_id = $1 and idempotency_key = $2', [customerId, idempotencyKey])
      return rows[0] ? String(rows[0].id) : null
    },

    create: draft => withTransaction(database, client => insertSubscription(client, draft, null)),

    async find(id) {
      const { rows } = await database.query<Row>(`select ${SUBSCRIPTION_COLUMNS} ${FROM} where s.id = $1`, [id])
      return (await withDetails(rows))[0] ?? null
    },

    async listForCustomer(customerId) {
      const { rows } = await database.query<Row>(`select ${SUBSCRIPTION_COLUMNS} ${FROM} where s.customer_id = $1 order by (s.status = 'active') desc, s.created_at desc limit 50`, [customerId])
      return withDetails(rows)
    },

    async listActive(afterId, limit) {
      const { rows } = await database.query<Row>(`select ${SUBSCRIPTION_COLUMNS} ${FROM} where s.status = 'active' and ($1::uuid is null or s.id > $1::uuid) order by s.id limit $2`, [afterId, limit])
      return withDetails(rows)
    },

    addSkip: (subscriptionId, lineId, date, reason) => withTransaction(database, async client => {
      if ((await lock(client, subscriptionId)) !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
      const { rows } = await client.query<Row>(
        'insert into subscription_skips (subscription_id, subscription_line_id, delivery_date, reason) select $1, l.id, $3, $4 from subscription_lines l where l.id = $2 and l.subscription_id = $1 on conflict (subscription_line_id, delivery_date) do nothing returning id',
        [subscriptionId, lineId, date, reason],
      )
      if (rows[0]) await activityIn(client, subscriptionId, 'skipped', { date, lineId, reason })
      return rows.length > 0
    }),

    removeSkip: (subscriptionId, lineId, date) => withTransaction(database, async client => {
      if ((await lock(client, subscriptionId)) !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
      const { rows } = await client.query<Row>("delete from subscription_skips where subscription_id = $1 and subscription_line_id = $2 and delivery_date = $3 and reason in ('customer', 'admin') returning id", [subscriptionId, lineId, date])
      if (rows[0]) await activityIn(client, subscriptionId, 'skip_undone', { date, lineId })
      return rows.length > 0
    }),

    async clearSkips(subscriptionId, days) {
      if (days.length === 0) return
      await database.query(
        "delete from subscription_skips k using jsonb_to_recordset($2::jsonb) as d(line_id uuid, day date) where k.subscription_id = $1 and k.subscription_line_id = d.line_id and k.delivery_date = d.day and k.reason in ('customer', 'admin', 'order_cancelled')",
        [subscriptionId, JSON.stringify(days.map(day => ({ line_id: day.lineId, day: day.date })))],
      )
    },

    addPause: (subscriptionId, pause, adminId) => withTransaction(database, async client => {
      if ((await lock(client, subscriptionId)) !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
      const { rows } = await client.query<Row>("select to_char(from_date, 'YYYY-MM-DD') as from_date, to_char(until_date, 'YYYY-MM-DD') as until_date from subscription_pauses where subscription_id = $1", [subscriptionId])
      const existing = rows.map(row => ({ fromDate: String(row.from_date), untilDate: row.until_date ? String(row.until_date) : null }))
      if (overlapsPause(existing, pause)) throw new AppError(409, 'PAUSE_OVERLAPS', 'These dates overlap a pause already set. Change or resume that one first.')
      await client.query('insert into subscription_pauses (subscription_id, from_date, until_date, created_by) values ($1, $2, $3, $4)', [subscriptionId, pause.fromDate, pause.untilDate, adminId])
      await activityIn(client, subscriptionId, 'paused', { fromDate: pause.fromDate, untilDate: pause.untilDate }, adminId)
    }),

    resume: (subscriptionId, fromDate) => withTransaction(database, async client => {
      if ((await lock(client, subscriptionId)) !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
      // The pause still running (or not yet started) on the resume date.
      const { rows } = await client.query<Row>(
        "select id, to_char(from_date, 'YYYY-MM-DD') as from_date from subscription_pauses where subscription_id = $1 and (until_date is null or until_date >= $2) order by from_date limit 1",
        [subscriptionId, fromDate],
      )
      const pause = rows[0]
      if (!pause) return false
      // A pause that has not begun by the resume date never takes effect: it is removed. Otherwise it ends the day before.
      if (String(pause.from_date) >= fromDate) await client.query('delete from subscription_pauses where id = $1', [pause.id])
      else await client.query("update subscription_pauses set until_date = ($2::date - interval '1 day')::date where id = $1", [pause.id, fromDate])
      await activityIn(client, subscriptionId, 'resumed', { fromDate })
      return true
    }),

    createDelivery: ({ subscriptionId, lineId, date, order }, now) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>('select status, customer_id, payment_method, payment_id, gift from subscriptions where id = $1 for update', [subscriptionId])
      const subscription = rows[0]
      if (!subscription || subscription.status !== 'active') return 'inactive'
      const skipped = await client.query<Row>('select 1 from subscription_skips where subscription_line_id = $1 and delivery_date = $2', [lineId, date])
      if (skipped.rows[0]) return 'skipped'
      const paused = await client.query<Row>('select 1 from subscription_pauses where subscription_id = $1 and from_date <= $2 and (until_date is null or until_date >= $2)', [subscriptionId, date])
      if (paused.rows[0]) return 'paused'
      const { rows: existing } = await client.query<Row>("select count(*) filter (where status <> 'cancelled')::int as live, count(*)::int as made from orders where subscription_line_id = $1 and delivery_date = $2", [lineId, date])
      if (Number((existing[0] as Row).live) > 0) return 'exists'
      // Each try at this day gets its own request key, so a day cancelled and later un-skipped can be ordered again.
      const idempotencyKey = `sub:${lineId}:${date}:${Number((existing[0] as Row).made)}`
      // The free gift goes out with the first delivery that is still going to happen: if that one was skipped or cancelled, the next one carries it.
      const gift = subscription.gift as SubscriptionGift | null
      let toWrite = order
      if (gift) {
        const { rows: carried } = await client.query<Row>("select 1 from order_items i join orders o on o.id = i.order_id where o.subscription_id = $1 and i.is_gift and o.status <> 'cancelled' limit 1", [subscriptionId])
        if (carried.length === 0) {
          toWrite = { ...order, items: [...order.items, { productId: gift.productId, variantId: gift.variantId, productName: gift.productName, productNameGu: gift.productNameGu, variantName: gift.variantName, unitPricePaise: 0, quantity: gift.quantity, lineTotalPaise: 0, isGift: true, includeInProductionPlanning: gift.includeInProductionPlanning, productionUnit: gift.productionUnit, productionQuantity: gift.productionQuantity, purchaseMethod: order.items[0]?.purchaseMethod ?? 'subscription' }] }
        }
      }
      await client.query('savepoint delivery_order')
      try {
        await insertOrders(client, String(subscription.customer_id), [{ ...toWrite, idempotencyKey }], now, subscription.payment_method === 'online' ? String(subscription.payment_id) : null)
        await client.query('release savepoint delivery_order')
        return 'created'
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        await client.query('rollback to savepoint delivery_order')
        if (error.code === 'CUSTOMER_NOT_ACTIVE') return 'customer_inactive'
        // Over the credit limit (or no longer a credit customer): this day is skipped, so the subscription runs one day longer.
        await client.query("insert into subscription_skips (subscription_id, subscription_line_id, delivery_date, reason) values ($1, $2, $3, 'credit_limit') on conflict (subscription_line_id, delivery_date) do nothing", [subscriptionId, lineId, date])
        await activityIn(client, subscriptionId, 'credit_limit_skipped', { date, lineId, code: error.code })
        return 'credit_limit'
      }
    }),

    ensureGiftCarrier: subscriptionId => withTransaction(database, async client => {
      const { rows } = await client.query<Row>("select gift, kind from subscriptions where id = $1 and status = 'active' for update", [subscriptionId])
      const gift = rows[0]?.gift as SubscriptionGift | null | undefined
      if (!gift) return
      const { rows: carried } = await client.query<Row>("select 1 from order_items i join orders o on o.id = i.order_id where o.subscription_id = $1 and i.is_gift and o.status <> 'cancelled' limit 1", [subscriptionId])
      if (carried.length > 0) return
      const { rows: next } = await client.query<Row>("select id from orders where subscription_id = $1 and status = 'placed' order by delivery_date, order_number limit 1", [subscriptionId])
      if (!next[0]) return
      await client.query(
        `insert into order_items (order_id, product_id, variant_id, product_name, product_name_gu, variant_name, purchase_method, unit_price_paise, quantity, line_total_paise, include_in_production_planning, production_unit, production_quantity, is_gift)
         values ($1, $2, $3, $4, $5, $6, $7, 0, $8, 0, $9, $10, $11, true)`,
        [next[0].id, gift.productId, gift.variantId, gift.productName, gift.productNameGu, gift.variantName, rows[0]?.kind, gift.quantity, gift.includeInProductionPlanning, gift.productionUnit, gift.productionQuantity],
      )
    }),

    async complete(subscriptionId) {
      const { rows } = await database.query<Row>("update subscriptions set status = 'completed', updated_at = now() where id = $1 and status = 'active' returning id", [subscriptionId])
      if (rows[0]) await activityIn(database, subscriptionId, 'completed')
    },

    markCancelled: (subscriptionId, reason, now) => withTransaction(database, async client => {
      if ((await lock(client, subscriptionId)) !== 'active') return false
      await client.query("update subscriptions set status = 'cancelled', cancelled_at = $2, cancel_reason = $3, updated_at = $2 where id = $1", [subscriptionId, now, reason.slice(0, 300)])
      await activityIn(client, subscriptionId, 'cancelled', { reason })
      return true
    }),

    async recordCancelRefund(subscriptionId, amountPaise, adminId) {
      if (amountPaise <= 0) return
      await database.query(
        `insert into prepaid_adjustments (customer_id, subscription_id, payment_id, adjustment_type, status, amount_paise, reason, effective_date, dedupe_key, created_by)
         select s.customer_id, s.id, s.payment_id, 'refund_pending', 'pending', $2, 'Subscription ' || s.subscription_number || ' cancelled with deliveries unused. Refund it in PhonePe, then record it.',
                (now() at time zone 'Asia/Kolkata')::date, 'subscription-cancel:' || s.id::text, $3
         from subscriptions s where s.id = $1 on conflict (dedupe_key) do nothing`,
        [subscriptionId, amountPaise, adminId],
      )
      await activityIn(database, subscriptionId, 'refund_due', { amountPaise }, adminId)
    },

    addActivity: (subscriptionId, kind, detail = {}, adminId = null) => activityIn(database, subscriptionId, kind, detail, adminId).then(() => undefined),

    async activity(subscriptionId) {
      const { rows } = await database.query<Row>('select kind, detail, created_at, created_by from subscription_activity where subscription_id = $1 order by created_at, id', [subscriptionId])
      return rows.map(row => ({ kind: String(row.kind), detail: (row.detail ?? {}) as Record<string, unknown>, createdAt: iso(row.created_at), byStaff: row.created_by !== null }))
    },

    async adminList({ search, kind, status, page, pageSize }, today) {
      const values: unknown[] = [today]
      const conditions: string[] = []
      if (kind) { values.push(kind); conditions.push(`s.kind = $${values.length}`) }
      // "Paused" is an active subscription with a pause covering today; "active" excludes those.
      const pausedToday = 'exists (select 1 from subscription_pauses p where p.subscription_id = s.id and p.from_date <= $1 and (p.until_date is null or p.until_date >= $1))'
      if (search) {
        values.push(likePattern(search))
        const n = values.length
        conditions.push(`(s.subscription_number ilike $${n} escape '\\' or c.name ilike $${n} escape '\\' or c.phone ilike $${n} escape '\\' or c.email ilike $${n} escape '\\' or s.product_name ilike $${n} escape '\\' or s.pin_code ilike $${n} escape '\\')`)
      }
      // The status tabs are counted with every filter but the status.
      const stateSql = `case when s.status = 'active' and ${pausedToday} then 'paused' else s.status end`
      const countQuery = database.query<Row>(`select ${stateSql} as state, count(*)::int as total ${FROM} ${conditions.length ? `where ${conditions.join(' and ')}` : ''} group by 1`, [...values])
      if (status === 'paused') conditions.push(`s.status = 'active' and ${pausedToday}`)
      else if (status === 'active') conditions.push(`s.status = 'active' and not ${pausedToday}`)
      else if (status) { values.push(status); conditions.push(`s.status = $${values.length}`) }
      values.push(pageSize, (page - 1) * pageSize)
      const { rows } = await database.query<Row>(
        `select ${SUBSCRIPTION_COLUMNS}, ${pausedToday} as paused_today,
                (select count(*)::int from orders o where o.subscription_id = s.id and o.status <> 'cancelled') as used,
                (select count(*)::int from orders o where o.subscription_id = s.id and o.status = 'delivered') as delivered_count,
                (select count(*)::int from subscription_skips k where k.subscription_id = s.id and k.reason in ('credit_limit', 'not_deliverable') and k.created_at > now() - interval '14 days') as alerts,
                (select to_char(o.delivery_date, 'YYYY-MM-DD') || '|' || coalesce(ds.name, '') from orders o left join delivery_slots ds on ds.id = o.delivery_slot_id
                   where o.subscription_id = s.id and o.status in ('placed', 'out_for_delivery') and o.delivery_date >= $1::date
                   order by o.delivery_date, ds.start_time nulls last limit 1) as next_delivery,
                count(*) over () as total
         ${FROM} ${conditions.length ? `where ${conditions.join(' and ')}` : ''}
         order by s.created_at desc limit $${values.length - 1} offset $${values.length}`,
        values,
      )
      const ids = rows.map(row => String(row.id))
      const lines = ids.length ? await database.query<Row>(LINES_SQL, [ids]) : { rows: [] as Row[] }
      const { rows: alertRows } = await database.query<Row>(
        `select k.subscription_id, s.subscription_number, c.name as customer_name, to_char(k.delivery_date, 'YYYY-MM-DD') as delivery_date, coalesce(ds.name, l.slot_name) as slot_name, k.reason, k.created_at
         from subscription_skips k join subscriptions s on s.id = k.subscription_id join customers c on c.id = s.customer_id join subscription_lines l on l.id = k.subscription_line_id left join delivery_slots ds on ds.id = l.delivery_slot_id
         where k.reason in ('credit_limit', 'not_deliverable') and k.created_at > now() - interval '7 days' order by k.created_at desc limit 20`,
      )
      const counts: SubscriptionStateCounts = { active: 0, paused: 0, completed: 0, cancelled: 0 }
      for (const row of (await countQuery).rows) counts[row.state as keyof SubscriptionStateCounts] = Number(row.total)
      const nextOf = (value: unknown) => {
        if (typeof value !== 'string') return null
        const [date = '', slotName = ''] = value.split('|')
        return { date, slotName }
      }
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        counts,
        rows: rows.map(row => ({
          ...toBase(row), paused: Boolean(row.paused_today), usedDeliveries: Number(row.used), deliveredDeliveries: Number(row.delivered_count), alerts: Number(row.alerts), nextDelivery: nextOf(row.next_delivery),
          lines: lines.rows.filter(line => String(line.subscription_id) === String(row.id)).map(line => ({ id: String(line.id), slotId: String(line.delivery_slot_id), slotName: String(line.slot_name), startTime: String(line.start_time), endTime: String(line.end_time), quantity: Number(line.quantity) })),
        })),
        alerts: alertRows.map(row => ({ subscriptionId: String(row.subscription_id), subscriptionNumber: String(row.subscription_number), customerName: String(row.customer_name ?? ''), date: String(row.delivery_date), slotName: String(row.slot_name), reason: row.reason as SkipReason, createdAt: iso(row.created_at) })),
      }
    },
  }
}
