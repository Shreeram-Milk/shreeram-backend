import type { PoolClient } from 'pg'
import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { AppError } from '../../http/errors.js'
import { likePattern } from '../master-data/shared.js'
import { lockOffer } from '../offers/redemption.js'
import type { DeliveryMethod } from '../products/schema.js'
import type { AdminOrderListQuery, CustomerOrderListQuery, OrderSource } from './schema.js'
import { canReturnMoney, canTransition, customerCanCancel, releasesMoney, withinCreditLimit, type CheckoutVariant, type OrderStatus } from './rules.js'

export type OrderItemView = {
  id: string; productId: string; variantId: string; productName: string; productNameGu: string; variantName: string
  purchaseMethod: 'buy_once' | 'trial' | 'subscription'; unitPricePaise: number; quantity: number; lineTotalPaise: number
  /** A free gift from an offer: costs nothing and goes if the purchase that earned it is cancelled. */
  isGift: boolean
}
export type OrderSlot = { id: string; name: string; startTime: string; endTime: string }

/** One order as customers and staff read it. */
export type OrderView = {
  id: string; orderNumber: string; status: OrderStatus; deliveryMethod: DeliveryMethod
  /** "2026-10-15", an India calendar date. */
  deliveryDate: string; slot: OrderSlot | null; orderBy: string | null
  /** Until when the customer can cancel (or skip) it. Null on orders made before this was recorded: their order-by time applies. */
  cancelBy: string | null
  recipientName: string; recipientPhone: string; addressLine1: string; addressLine2: string; landmark: string; city: string; pinCode: string; doorstepNote: string
  subtotalPaise: number; discountPaise: number; totalPaise: number
  /** The offer that took money off or gave a gift, as it was named when the order was placed ('' when none). */
  offerTitle: string; offerTitleGu: string
  paymentMethod: 'credit' | 'online'; paymentStatus: 'unpaid' | 'paid' | 'partially_refunded' | 'refunded'
  placedAt: string; cancelledAt: string | null; cancelReason: string
  items: OrderItemView[]
  /** Set when the order is one delivery of a subscription or trial. */
  subscriptionId: string | null
  /** Courier orders: the courier and tracking link staff entered ('' until then). */
  courierName: string; trackingUrl: string
  /** When staff returned the money for this order (missed or unhappy delivery), or null. */
  moneyReturnedAt: string | null
}
/** The online payment behind an order, for staff: references and how it was paid. */
export type OrderPaymentInfo = {
  id: string; merchantOrderId: string; providerOrderId: string | null; providerTransactionId: string | null; status: string; amountPaise: number; paidAt: string | null
  mode: string | null; instrument: string | null; bank: string | null; bankReference: string | null
}
export type AdminOrderView = OrderView & { customerId: string; customerName: string; customerPhone: string; onlinePayment?: OrderPaymentInfo | null }

/** What is needed to write one order. The service has already priced, grouped and checked it. */
export type NewOrderItem = {
  productId: string; variantId: string; productName: string; productNameGu: string; variantName: string
  unitPricePaise: number; quantity: number; lineTotalPaise: number
  includeInProductionPlanning: boolean; productionUnit: string; productionQuantity: number
  /** How it was bought; a one-off purchase when absent. */
  purchaseMethod?: 'buy_once' | 'trial' | 'subscription'
  isGift?: boolean
}
export type NewOrder = {
  idempotencyKey: string; deliveryMethod: DeliveryMethod; serviceAreaId: string; deliveryDate: string; slot: OrderSlot | null; orderBy: string | null
  /** Until when the customer can cancel it; null for courier orders (they can be cancelled until sent). */
  cancelBy: string | null
  recipientName: string; recipientPhone: string; addressLine1: string; addressLine2: string; landmark: string; city: string; pinCode: string; doorstepNote: string
  items: NewOrderItem[]; subtotalPaise: number; totalPaise: number
  /** This order's share of the checkout's offer discount (total = subtotal - discount). */
  discountPaise?: number
  /** The offer the whole checkout used. `checkoutKey` groups its orders so the offer counts once. */
  offer?: { id: string; title: string; titleGu: string; checkoutKey: string }
  /** Only the name of an offer already recorded elsewhere (a subscription's offer), shown on each delivery. */
  offerLabel?: { title: string; titleGu: string }
  /** Credit adds to what the customer owes; online orders are written only once their payment is confirmed, and point at that payment. */
  payment: { method: 'credit' } | { method: 'online' }
  /** One delivery of a subscription or trial: the subscription and the slot line it belongs to. */
  subscription?: { id: string; lineId: string }
}

export type CustomerMoney = { status: 'active' | 'blocked' | 'deleted'; customerType: 'prepaid' | 'credit'; creditLimitPaise: number; owedPaise: number }
export type Actor = { adminId: string } | { customer: true }

/** Storage for orders. The Postgres version below is the real one; tests use a fake. */
export interface OrderRepository {
  /** The sizes asked for, with everything needed to price and group them. Sizes that do not exist are simply missing from the answer. */
  loadVariants(variantIds: string[]): Promise<CheckoutVariant[]>
  customerMoney(customerId: string): Promise<CustomerMoney | null>
  /** Orders this customer already made with request keys starting with `prefix` (a repeated "Place order"). */
  findByKeyPrefix(customerId: string, prefix: string): Promise<OrderView[]>
  /**
   * Writes every order of one checkout, with its items, status history, payment record and credit charge, as one all-or-nothing step.
   * Under a lock on the customer, so two orders at once cannot together go over the credit limit.
   */
  placeOrders(customerId: string, orders: NewOrder[], now: Date): Promise<OrderView[]>
  listForCustomer(customerId: string, query: CustomerOrderListQuery): Promise<{ orders: OrderView[]; total: number }>
  findForCustomer(customerId: string, orderId: string): Promise<OrderView | null>
  /** This customer's orders (one-off and subscription) delivered between two dates, for the delivery calendar. */
  deliveriesBetween(customerId: string, from: string, to: string): Promise<OrderView[]>
  /**
   * One page of orders, plus how many orders match in each status (with every filter but the status) and of each type
   * (with every filter but the status and the type), for the summary.
   */
  adminList(query: AdminOrderListQuery): Promise<{ rows: AdminOrderView[]; total: number; counts: Record<OrderStatus, number>; typeCounts: Record<OrderSource, number> }>
  adminFind(orderId: string): Promise<AdminOrderView | null>
  /**
   * Moves an order to a new status (checking the step is legal, under a lock), records the history and, for a cancelled
   * order, gives the money back: a credit charge is reversed, an online payment is noted as "refund pending" for staff.
   * A cancelled subscription delivery becomes a skip (the subscription runs one delivery longer) instead of a refund.
   * A missed order changes nothing about money: staff decide separately (returnMoney).
   * `ownedBy` limits it to one customer's own order.
   */
  changeStatus(orderId: string, to: OrderStatus, input: { actor: Actor; note: string; reason: string; ownedBy?: string }, now: Date): Promise<OrderView | null>
  /**
   * Staff return the money for a missed or delivered order, once: a credit order's charge is reversed; an order paid online
   * gets a "refund to send" item. The order's status does not change.
   */
  returnMoney(orderId: string, input: { adminId: string; reason: string }, now: Date): Promise<OrderView | null>
  /** The courier and tracking link of a courier order. */
  setCourier(orderId: string, input: { courierName: string; trackingUrl: string }): Promise<OrderView | null>
}

type Row = Record<string, unknown>

/**
 * The delivery window of an order is shown with the slot's name and times as they are NOW, so renaming a slot in the admin
 * changes it everywhere at once. The name and times saved with the order are only a fallback (they are what the order was
 * placed with, and what is shown if the slot row were ever gone).
 */
const SLOT_NAME = '(coalesce((select ds.name from delivery_slots ds where ds.id = o.delivery_slot_id), o.slot_name))'
const SLOT_START = '(coalesce((select ds.start_time from delivery_slots ds where ds.id = o.delivery_slot_id), o.slot_start_time))'
const SLOT_END = '(coalesce((select ds.end_time from delivery_slots ds where ds.id = o.delivery_slot_id), o.slot_end_time))'
/**
 * Orders still to deliver first, nearest delivery on top (then by window); everything else after, the most recent delivery first.
 * Used by both the admin list and the customer's My Orders, so a subscription's days always read in the order they happen.
 */
const COMING_FIRST = `(o.status not in ('placed', 'out_for_delivery')),
  (case when o.status in ('placed', 'out_for_delivery') then o.delivery_date end) asc,
  (case when o.status in ('placed', 'out_for_delivery') then ${SLOT_START} end) asc nulls last,
  (case when o.status not in ('placed', 'out_for_delivery') then o.delivery_date end) desc`
const ORDER_COLUMNS = `o.id, o.order_number, o.status, o.delivery_method, to_char(o.delivery_date, 'YYYY-MM-DD') as delivery_date, o.delivery_slot_id, ${SLOT_NAME} as slot_name,
  to_char(${SLOT_START}, 'HH24:MI') as slot_start, to_char(${SLOT_END}, 'HH24:MI') as slot_end, o.order_by, o.cancel_by,
  o.recipient_name, o.recipient_phone, o.address_line1, o.address_line2, o.landmark, o.city, o.pin_code, o.doorstep_note,
  o.subtotal_paise, o.discount_paise, o.total_paise, o.offer_title, o.offer_title_gu, o.payment_method, o.payment_status, o.placed_at, o.cancelled_at, o.cancel_reason,
  o.subscription_id, o.courier_name, o.tracking_url, o.money_returned_at`
const ITEM_COLUMNS = 'id, order_id, product_id, variant_id, product_name, product_name_gu, variant_name, purchase_method, unit_price_paise, quantity, line_total_paise, is_gift'
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

const toItem = (row: Row): OrderItemView => ({
  id: String(row.id), productId: String(row.product_id), variantId: String(row.variant_id), productName: String(row.product_name), productNameGu: String(row.product_name_gu),
  variantName: String(row.variant_name), purchaseMethod: row.purchase_method as OrderItemView['purchaseMethod'], unitPricePaise: Number(row.unit_price_paise),
  quantity: Number(row.quantity), lineTotalPaise: Number(row.line_total_paise), isGift: Boolean(row.is_gift),
})
const toOrder = (row: Row, items: OrderItemView[]): OrderView => ({
  id: String(row.id), orderNumber: String(row.order_number), status: row.status as OrderStatus, deliveryMethod: row.delivery_method as DeliveryMethod, deliveryDate: String(row.delivery_date),
  slot: row.delivery_slot_id ? { id: String(row.delivery_slot_id), name: String(row.slot_name), startTime: String(row.slot_start), endTime: String(row.slot_end) } : null,
  orderBy: row.order_by ? iso(row.order_by) : null,
  cancelBy: row.cancel_by ? iso(row.cancel_by) : null,
  recipientName: String(row.recipient_name), recipientPhone: String(row.recipient_phone), addressLine1: String(row.address_line1), addressLine2: String(row.address_line2),
  landmark: String(row.landmark), city: String(row.city), pinCode: String(row.pin_code), doorstepNote: String(row.doorstep_note),
  subtotalPaise: Number(row.subtotal_paise), discountPaise: Number(row.discount_paise), totalPaise: Number(row.total_paise),
  offerTitle: String(row.offer_title ?? ''), offerTitleGu: String(row.offer_title_gu ?? ''),
  paymentMethod: row.payment_method as OrderView['paymentMethod'], paymentStatus: row.payment_status as OrderView['paymentStatus'],
  placedAt: iso(row.placed_at), cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null, cancelReason: String(row.cancel_reason), items,
  subscriptionId: row.subscription_id ? String(row.subscription_id) : null, courierName: String(row.courier_name ?? ''), trackingUrl: String(row.tracking_url ?? ''),
  moneyReturnedAt: row.money_returned_at ? iso(row.money_returned_at) : null,
})

/**
 * Writes every order of one checkout, with its items, status history and credit charge, inside the caller's transaction.
 * Under a lock on the customer, so two checkouts at once cannot together go over the credit limit. Online orders are linked to
 * `onlinePaymentId`, the payment already confirmed for them. Throws AppError for a business refusal (account blocked,
 * credit limit), so a caller holding a confirmed payment can undo just this part and record a refund instead.
 */
export async function insertOrders(client: PoolClient, customerId: string, orders: NewOrder[], now: Date, onlinePaymentId: string | null): Promise<OrderView[]> {
  // One customer at a time: this lock is what keeps two simultaneous checkouts from together going over the credit limit.
  const { rows: customerRows } = await client.query<Row>('select status, customer_type, credit_limit_paise from customers where id = $1 for update', [customerId])
  const customer = customerRows[0]
  if (!customer || customer.status !== 'active') throw new AppError(403, 'CUSTOMER_NOT_ACTIVE', 'This account cannot place orders.')

  const creditTotal = orders.filter(order => order.payment.method === 'credit').reduce((sum, order) => sum + order.totalPaise, 0)
  if (creditTotal > 0) {
    if (customer.customer_type !== 'credit') throw new AppError(409, 'CREDIT_NOT_ENABLED', 'This account does not have credit.')
    const { rows: owedRows } = await client.query<Row>("select coalesce(sum(case when direction = 'debit' then amount_paise else -amount_paise end), 0) as owed from credit_ledger_entries where customer_id = $1", [customerId])
    const owed = Number((owedRows[0] as Row).owed)
    const limit = Number(customer.credit_limit_paise)
    if (!withinCreditLimit(limit, owed, creditTotal)) throw new AppError(409, 'CREDIT_LIMIT_EXCEEDED', 'This order is above your credit limit.', { limitPaise: limit, owedPaise: owed, neededPaise: creditTotal })
  }

  // The offer is checked again under a lock on its row: two checkouts at once cannot both take the last use.
  const offerRef = orders.find(order => order.offer)?.offer
  if (offerRef) await lockOffer(client, customerId, offerRef)

  const placed: string[] = []
  for (const order of orders) {
    const paymentId = order.payment.method === 'online' ? onlinePaymentId : null
    if (order.payment.method === 'online' && !paymentId) throw new Error('An online order needs its confirmed payment.')
    const { rows } = await client.query<Row>(
      `insert into orders (customer_id, idempotency_key, delivery_method, service_area_id, delivery_date, delivery_slot_id, slot_name, slot_start_time, slot_end_time, order_by, cancel_by,
         recipient_name, recipient_phone, address_line1, address_line2, landmark, city, pin_code, doorstep_note,
         subtotal_paise, discount_paise, total_paise, payment_method, payment_status, payment_id, placed_at, updated_at, offer_id, offer_title, offer_title_gu)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $25, $11, $12, $13, $14, $15, $16, $17, $18, $19, $26, $20, $21, $22, $23, $24, $24, $27, $28, $29) returning id`,
      [customerId, order.idempotencyKey, order.deliveryMethod, order.serviceAreaId, order.deliveryDate, order.slot?.id ?? null, order.slot?.name ?? '', order.slot?.startTime ?? null, order.slot?.endTime ?? null, order.orderBy,
        order.recipientName, order.recipientPhone, order.addressLine1, order.addressLine2, order.landmark, order.city, order.pinCode, order.doorstepNote,
        order.subtotalPaise, order.totalPaise, order.payment.method, order.payment.method === 'online' ? 'paid' : 'unpaid', paymentId, now, order.cancelBy,
        order.discountPaise ?? 0, order.offer?.id ?? null, order.offer?.title ?? order.offerLabel?.title ?? '', order.offer?.titleGu ?? order.offerLabel?.titleGu ?? ''],
    )
    const orderId = String((rows[0] as Row).id)
    placed.push(orderId)
    // A payment covering several orders points at the first of them; every order points at the payment.
    if (paymentId) await client.query('update payments set order_id = $2 where id = $1 and order_id is null', [paymentId, orderId])
    await client.query(
      `insert into order_items (order_id, product_id, variant_id, product_name, product_name_gu, variant_name, purchase_method, unit_price_paise, quantity, line_total_paise, include_in_production_planning, production_unit, production_quantity, is_gift)
       select $1, i.product_id, i.variant_id, i.product_name, i.product_name_gu, i.variant_name, coalesce(i.purchase_method, 'buy_once'), i.unit_price_paise, i.quantity, i.line_total_paise, i.include_in_production_planning, i.production_unit, i.production_quantity, coalesce(i.is_gift, false)
       from jsonb_to_recordset($2::jsonb) as i(product_id uuid, variant_id uuid, product_name text, product_name_gu text, variant_name text, purchase_method text, unit_price_paise bigint, quantity integer, line_total_paise bigint, include_in_production_planning boolean, production_unit text, production_quantity numeric, is_gift boolean)`,
      [orderId, JSON.stringify(order.items.map(item => ({
        product_id: item.productId, variant_id: item.variantId, product_name: item.productName, product_name_gu: item.productNameGu, variant_name: item.variantName, purchase_method: item.purchaseMethod ?? null, unit_price_paise: item.unitPricePaise,
        quantity: item.quantity, line_total_paise: item.lineTotalPaise, include_in_production_planning: item.includeInProductionPlanning, production_unit: item.productionUnit, production_quantity: item.productionQuantity, is_gift: item.isGift ?? false,
      })))],
    )
    if (order.offer) {
      await client.query('insert into offer_redemptions (offer_id, customer_id, checkout_key, order_id, discount_paise) values ($1, $2, $3, $4, $5)', [order.offer.id, customerId, order.offer.checkoutKey, orderId, order.discountPaise ?? 0])
    }
    if (order.subscription) await client.query('update orders set subscription_id = $2, subscription_line_id = $3 where id = $1', [orderId, order.subscription.id, order.subscription.lineId])
    await client.query("insert into order_status_history (order_id, from_status, to_status, changed_by_customer) values ($1, null, 'placed', true)", [orderId])
    if (order.payment.method === 'credit') {
      await client.query(
        "insert into credit_ledger_entries (customer_id, entry_type, direction, amount_paise, order_id, description, occurred_on, created_at) values ($1, 'order_charge', 'debit', $2, $3, 'Order placed', (now() at time zone 'Asia/Kolkata')::date, clock_timestamp())",
        [customerId, order.totalPaise, orderId],
      )
    }
  }
  const { rows } = await client.query<Row>(`select ${ORDER_COLUMNS} from orders o where o.id = any($1::uuid[]) order by o.idempotency_key`, [placed])
  const { rows: itemRows } = await client.query<Row>(`select ${ITEM_COLUMNS} from order_items where order_id = any($1::uuid[]) order by id`, [placed])
  return rows.map(row => toOrder(row, itemRows.filter(item => String(item.order_id) === String(row.id)).map(toItem)))
}

export function createOrderRepository(database: Database): OrderRepository {
  /** Attaches the items of several orders, each asked for once (never one query per order). */
  async function withItems(rows: Row[]): Promise<Array<{ row: Row; order: OrderView }>> {
    if (rows.length === 0) return []
    const { rows: itemRows } = await database.query<Row>(`select ${ITEM_COLUMNS} from order_items where order_id = any($1::uuid[]) order by id`, [rows.map(row => String(row.id))])
    const byOrder = new Map<string, OrderItemView[]>()
    for (const itemRow of itemRows) {
      const key = String(itemRow.order_id)
      const list = byOrder.get(key)
      if (list) list.push(toItem(itemRow)); else byOrder.set(key, [toItem(itemRow)])
    }
    return rows.map(row => ({ row, order: toOrder(row, byOrder.get(String(row.id)) ?? []) }))
  }

  return {
    async loadVariants(variantIds) {
      const { rows } = await database.query<Row>(
        `select v.id as variant_id, v.name as variant_name, v.price_paise, v.status as variant_status, v.production_unit, v.production_quantity::float8 as production_quantity,
                p.id as product_id, p.name as product_name, p.name_gu as product_name_gu, p.status as product_status, c.status as category_status,
                p.delivery_method, p.service_area_id, p.cutoff_rule_id, p.include_in_production_planning, p.excluded_from_credit, p.purchase_methods
         from product_variants v join products p on p.id = v.product_id join categories c on c.id = p.category_id
         where v.id = any($1::uuid[])`,
        [variantIds],
      )
      return rows.map((row): CheckoutVariant => ({
        variantId: String(row.variant_id), variantName: String(row.variant_name), pricePaise: Number(row.price_paise), variantActive: row.variant_status === 'active',
        productId: String(row.product_id), productName: String(row.product_name), productNameGu: String(row.product_name_gu),
        productActive: row.product_status === 'active', categoryActive: row.category_status === 'active', purchaseMethods: row.purchase_methods as string[],
        deliveryMethod: (row.delivery_method as DeliveryMethod | null) ?? null, serviceAreaId: row.service_area_id ? String(row.service_area_id) : null, cutoffRuleId: row.cutoff_rule_id ? String(row.cutoff_rule_id) : null,
        includeInProductionPlanning: Boolean(row.include_in_production_planning), excludedFromCredit: Boolean(row.excluded_from_credit),
        productionUnit: String(row.production_unit), productionQuantity: Number(row.production_quantity),
      }))
    },

    async customerMoney(customerId) {
      const { rows } = await database.query<Row>(
        `select c.status, c.customer_type, c.credit_limit_paise,
                coalesce((select sum(case when l.direction = 'debit' then l.amount_paise else -l.amount_paise end) from credit_ledger_entries l where l.customer_id = c.id), 0) as owed
         from customers c where c.id = $1`,
        [customerId],
      )
      const row = rows[0]
      return row ? { status: row.status as CustomerMoney['status'], customerType: row.customer_type as CustomerMoney['customerType'], creditLimitPaise: Number(row.credit_limit_paise), owedPaise: Number(row.owed) } : null
    },

    async findByKeyPrefix(customerId, prefix) {
      const { rows } = await database.query<Row>(`select ${ORDER_COLUMNS} from orders o where o.customer_id = $1 and o.idempotency_key like $2 escape '\\' order by o.idempotency_key`, [customerId, `${likePattern(prefix).slice(1, -1)}%`])
      return (await withItems(rows)).map(entry => entry.order)
    },

    placeOrders: (customerId, orders, now) => withTransaction(database, client => insertOrders(client, customerId, orders, now, null)),

    async listForCustomer(customerId, { page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${ORDER_COLUMNS}, count(*) over() as total from orders o where o.customer_id = $1 order by ${COMING_FIRST}, o.placed_at desc, o.id limit $2 offset $3`,
        [customerId, pageSize, (page - 1) * pageSize],
      )
      return { orders: (await withItems(rows)).map(entry => entry.order), total: rows[0] ? Number(rows[0].total) : 0 }
    },

    async deliveriesBetween(customerId, from, to) {
      const { rows } = await database.query<Row>(`select ${ORDER_COLUMNS} from orders o where o.customer_id = $1 and o.delivery_date between $2::date and $3::date order by o.delivery_date, ${SLOT_START} nulls last limit 500`, [customerId, from, to])
      return (await withItems(rows)).map(entry => entry.order)
    },

    async findForCustomer(customerId, orderId) {
      const { rows } = await database.query<Row>(`select ${ORDER_COLUMNS} from orders o where o.id = $1 and o.customer_id = $2`, [orderId, customerId])
      return (await withItems(rows))[0]?.order ?? null
    },

    async adminList({ search, status, date, slotId, source, productId, payment, page, pageSize }) {
      // One delivery day is read as a route: by window, then PIN code. Otherwise what is still to deliver comes first, the nearest
      // delivery on top (a subscription's days then read in the order they happen); finished orders follow, the latest first.
      const order = date ? `${SLOT_START} nulls last, o.pin_code, o.order_number` : `${COMING_FIRST}, o.placed_at desc, o.id`
      // Every filter but the status ($1); the summary counts use these alone.
      const filters = `($2::date is null or o.delivery_date = $2::date) and ($3::uuid is null or o.delivery_slot_id = $3::uuid)
           and ($4::text is null or o.order_number ilike $4 or o.recipient_name ilike $4 or o.pin_code ilike $4 or c.phone ilike $4 or c.email ilike $4)
           and ($5::text is null or ($5 = 'one_time' and o.subscription_id is null) or ($5 <> 'one_time' and o.subscription_id is not null and exists (select 1 from order_items x where x.order_id = o.id and x.purchase_method = $5)))
           and ($6::uuid is null or exists (select 1 from order_items x where x.order_id = o.id and x.product_id = $6::uuid))
           and ($7::text is null or o.payment_method = $7)`
      const filterValues = [date ?? null, slotId ?? null, search ? likePattern(search) : null, source ?? null, productId ?? null, payment ?? null]
      const [{ rows }, { rows: countRows }] = await Promise.all([
        database.query<Row>(
          `select ${ORDER_COLUMNS}, o.customer_id, c.name as customer_name, coalesce(c.phone, nullif(c.email, '')) as customer_phone, count(*) over() as total
           from orders o join customers c on c.id = o.customer_id
           where ($1::text is null or o.status = $1) and ${filters}
           order by ${order} limit $8 offset $9`,
          [status ?? null, ...filterValues, pageSize, (page - 1) * pageSize],
        ),
        // Counted without the type filter ($5 is null), so each type keeps its own count while one type is chosen.
        database.query<Row>(
          `select o.status, case when o.subscription_id is null then 'one_time'
                  when exists (select 1 from order_items x where x.order_id = o.id and x.purchase_method = 'trial') then 'trial' else 'subscription' end as kind,
                  count(*)::int as total
           from orders o join customers c on c.id = o.customer_id where $1::text is null and ${filters} group by 1, 2`,
          [null, ...filterValues.map((value, index) => (index === 3 ? null : value))],
        ),
      ])
      const counts = { placed: 0, out_for_delivery: 0, delivered: 0, missed: 0, cancelled: 0 } as Record<OrderStatus, number>
      const typeCounts: Record<OrderSource, number> = { one_time: 0, subscription: 0, trial: 0 }
      for (const row of countRows) {
        const kind = row.kind as OrderSource
        typeCounts[kind] += Number(row.total)
        if (!source || source === kind) counts[row.status as OrderStatus] += Number(row.total)
      }
      const entries = await withItems(rows)
      return {
        counts,
        typeCounts,
        total: rows[0] ? Number(rows[0].total) : 0,
        rows: entries.map(({ row, order }): AdminOrderView => ({ ...order, customerId: String(row.customer_id), customerName: String(row.customer_name), customerPhone: row.customer_phone ? String(row.customer_phone) : '' })),
      }
    },

    async adminFind(orderId) {
      const { rows } = await database.query<Row>(
        `select ${ORDER_COLUMNS}, o.customer_id, c.name as customer_name, coalesce(c.phone, nullif(c.email, '')) as customer_phone,
                p.id as pay_id, p.provider_reference as pay_reference, p.provider_order_id as pay_provider_order, p.provider_transaction_id as pay_transaction,
                p.status as pay_status, p.amount_paise as pay_amount, p.paid_at as pay_paid_at,
                p.payment_mode as pay_mode, p.payment_instrument as pay_instrument, p.payment_bank as pay_bank, p.bank_reference as pay_bank_reference
         from orders o join customers c on c.id = o.customer_id left join payments p on p.id = o.payment_id and p.method = 'phonepe' where o.id = $1`,
        [orderId],
      )
      const entry = (await withItems(rows))[0]
      if (!entry) return null
      const row = entry.row
      const optional = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value))
      const onlinePayment: OrderPaymentInfo | null = row.pay_id ? {
        id: String(row.pay_id), merchantOrderId: String(row.pay_reference), providerOrderId: optional(row.pay_provider_order), providerTransactionId: optional(row.pay_transaction),
        status: String(row.pay_status), amountPaise: Number(row.pay_amount), paidAt: row.pay_paid_at ? iso(row.pay_paid_at) : null,
        mode: optional(row.pay_mode), instrument: optional(row.pay_instrument), bank: optional(row.pay_bank), bankReference: optional(row.pay_bank_reference),
      } : null
      return { ...entry.order, customerId: String(row.customer_id), customerName: String(row.customer_name), customerPhone: row.customer_phone ? String(row.customer_phone) : '', onlinePayment }
    },

    changeStatus: (orderId, to, { actor, note, reason, ownedBy }, now) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>(
        "select id, customer_id, order_number, status, total_paise, payment_method, payment_status, delivery_method, order_by, cancel_by, to_char(delivery_date, 'YYYY-MM-DD') as delivery_date, subscription_id, subscription_line_id from orders where id = $1 and ($2::uuid is null or customer_id = $2::uuid) for update",
        [orderId, ownedBy ?? null],
      )
      const order = rows[0]
      if (!order) return null
      const from = order.status as OrderStatus
      // A customer's own cancel is only allowed while ordering is still open. Checked here, under the lock, so it cannot race with staff.
      if ('customer' in actor && to === 'cancelled' && !customerCanCancel({ status: from, deliveryMethod: order.delivery_method as DeliveryMethod, orderBy: order.order_by ? iso(order.order_by) : null, cancelBy: order.cancel_by ? iso(order.cancel_by) : null, deliveryDate: String(order.delivery_date) }, now)) {
        throw new AppError(409, 'CANCEL_NOT_ALLOWED', 'This order can no longer be cancelled. Please contact support.')
      }
      if (!canTransition(from, to)) throw new AppError(409, 'INVALID_STATUS_STEP', `An order that is ${from.replaceAll('_', ' ')} cannot become ${to.replaceAll('_', ' ')}.`)
      const adminId = 'adminId' in actor ? actor.adminId : null
      await client.query(
        `update orders set status = $2, updated_at = $3,
           cancelled_at = case when $2 = 'cancelled' then $3 else cancelled_at end, cancelled_by = case when $2 = 'cancelled' then $4 else cancelled_by end,
           cancel_reason = case when $2 = 'cancelled' then $5 else cancel_reason end where id = $1`,
        [orderId, to, now, 'customer' in actor ? 'customer' : 'admin', reason],
      )
      await client.query('insert into order_status_history (order_id, from_status, to_status, changed_by_admin, changed_by_customer, note) values ($1, $2, $3, $4, $5, $6)', [orderId, from, to, adminId, 'customer' in actor, note])
      // A cancelled subscription delivery is not lost: the day becomes a skip, which moves that slot's end date one delivery
      // later. Its money is therefore not refunded (the delivery will still happen); a credit charge is reversed, as it is
      // charged again when the later delivery's order is created.
      const subscriptionDelivery = Boolean(order.subscription_line_id)
      if (to === 'cancelled' && subscriptionDelivery) {
        await client.query(
          "insert into subscription_skips (subscription_id, subscription_line_id, delivery_date, reason) values ($1, $2, $3, $4) on conflict (subscription_line_id, delivery_date) do nothing",
          [order.subscription_id, order.subscription_line_id, order.delivery_date, 'customer' in actor ? 'customer' : 'order_cancelled'],
        )
      }
      if (releasesMoney(to)) {
        const total = Number(order.total_paise)
        if (order.payment_method === 'credit') {
          await client.query(
            "insert into credit_ledger_entries (customer_id, entry_type, direction, amount_paise, order_id, description, created_by, occurred_on, created_at) values ($1, 'order_refund', 'credit', $2, $3, $4, $5, (now() at time zone 'Asia/Kolkata')::date, clock_timestamp())",
            [order.customer_id, total, orderId, `Order ${String(order.order_number)} ${to}`, adminId],
          )
        } else if (order.payment_status === 'paid' && !subscriptionDelivery) {
          await client.query(
            `insert into prepaid_adjustments (customer_id, order_id, adjustment_type, status, amount_paise, reason, effective_date, dedupe_key, created_by)
             values ($1, $2, 'refund_pending', 'pending', $3, $4, (now() at time zone 'Asia/Kolkata')::date, $5, $6) on conflict (dedupe_key) do nothing`,
            [order.customer_id, orderId, total, `Order ${String(order.order_number)} ${to}: refund the payment in PhonePe, then record it.`, `order-release:${orderId}`, adminId],
          )
        }
      }
      return readOrder(client, orderId)
    }),

    returnMoney: (orderId, { adminId, reason }, now) => withTransaction(database, async client => {
      const { rows } = await client.query<Row>('select id, customer_id, order_number, status, total_paise, payment_method, payment_status, payment_id, money_returned_at from orders where id = $1 for update', [orderId])
      const order = rows[0]
      if (!order) return null
      if (!canReturnMoney(order.status as OrderStatus)) throw new AppError(409, 'RETURN_NOT_ALLOWED', 'Money can be returned only for a missed or delivered order.')
      if (order.money_returned_at) throw new AppError(409, 'MONEY_ALREADY_RETURNED', 'The money for this order was already returned.')
      const total = Number(order.total_paise)
      if (order.payment_method === 'credit') {
        await client.query(
          "insert into credit_ledger_entries (customer_id, entry_type, direction, amount_paise, order_id, description, created_by, occurred_on, created_at) values ($1, 'order_refund', 'credit', $2, $3, $4, $5, (now() at time zone 'Asia/Kolkata')::date, clock_timestamp())",
          [order.customer_id, total, orderId, `Order ${String(order.order_number)}: credited by staff (${reason})`.slice(0, 300), adminId],
        )
      } else if (order.payment_status === 'paid' || order.payment_status === 'partially_refunded') {
        await client.query(
          `insert into prepaid_adjustments (customer_id, order_id, payment_id, adjustment_type, status, amount_paise, reason, effective_date, dedupe_key, created_by)
           values ($1, $2, $3, 'refund_pending', 'pending', $4, $5, (now() at time zone 'Asia/Kolkata')::date, $6, $7) on conflict (dedupe_key) do nothing`,
          [order.customer_id, orderId, order.payment_id ?? null, total, `Order ${String(order.order_number)}: ${reason}. Refund it in PhonePe, then record it.`.slice(0, 300), `order-return:${orderId}`, adminId],
        )
      } else {
        throw new AppError(409, 'NOTHING_TO_RETURN', 'This order has no payment to return.')
      }
      await client.query('update orders set money_returned_at = $2, updated_at = $2 where id = $1', [orderId, now])
      await client.query('insert into order_status_history (order_id, from_status, to_status, changed_by_admin, changed_by_customer, note) values ($1, $2, $2, $3, false, $4)', [orderId, order.status, adminId, `Money returned: ${reason}`.slice(0, 300)])
      return readOrder(client, orderId)
    }),

    async setCourier(orderId, { courierName, trackingUrl }) {
      const { rows } = await database.query<Row>("update orders set courier_name = $2, tracking_url = $3, updated_at = now() where id = $1 and delivery_method = 'shipping' returning id", [orderId, courierName || null, trackingUrl || null])
      if (!rows[0]) {
        const exists = await database.query<Row>('select 1 from orders where id = $1', [orderId])
        if (exists.rows[0]) throw new AppError(409, 'NOT_A_COURIER_ORDER', 'Only courier orders have a courier and tracking link.')
        return null
      }
      return readOrder(database, orderId)
    },
  }
}

async function readOrder(client: Pick<PoolClient, 'query'>, orderId: string): Promise<OrderView> {
  const { rows: updated } = await client.query<Row>(`select ${ORDER_COLUMNS} from orders o where o.id = $1`, [orderId])
  const { rows: itemRows } = await client.query<Row>(`select ${ITEM_COLUMNS} from order_items where order_id = $1 order by id`, [orderId])
  return toOrder(updated[0] as Row, itemRows.map(toItem))
}
