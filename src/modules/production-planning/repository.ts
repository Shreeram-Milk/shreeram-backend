import type { Database } from '../../db/pool.js'
import { RIDER_SHEET_LIMIT, type RiderSheetSlot, type RiderStopRow } from './rider-sheet.js'
import type { DemandRow, SlotClosing } from './rules.js'

/** What production planning reads. The Postgres version below is the real one; tests use a fake. */
export interface ProductionPlanRepository {
  /**
   * Demand for one delivery day: own-delivery orders still wanted (not cancelled or missed), only items of products marked
   * "include in production planning", added up per window, product and size, and split by one-time, trial and subscription.
   * Cancelled (or skipped) pieces are counted separately so staff see what dropped out. Reads the figures saved on each item.
   */
  demandFor(date: string): Promise<{ rows: DemandRow[]; closings: SlotClosing[] }>
  /**
   * The houses a rider visits in one window: local deliveries still placed or out for delivery, with every item (not only
   * products in production planning, since the rider carries them all), when the window closes, and the window itself (null when
   * there is no such slot). Lists at most RIDER_SHEET_LIMIT houses and says when there were more.
   */
  riderStopsFor(date: string, slotId: string): Promise<{ slot: RiderSheetSlot | null; stops: RiderStopRow[]; closing: SlotClosing | null; truncated: boolean }>
}

type Row = Record<string, unknown>

/**
 * When each window of a day closes. The window is final when nothing in it can change any more: after the order-by time (no new
 * orders) AND the cancel-by time (no cancellations), whichever is later, for each order. If every order in it was cancelled, the
 * cancelled ones still tell when it closes.
 */
const CLOSINGS_SQL = `select slot_id,
                  case when active > 0 then (case when active_without_time > 0 then null else active_latest end) else any_latest end as closes_at,
                  active as order_count
           from (
             select delivery_slot_id as slot_id,
                    count(*) filter (where status not in ('cancelled', 'missed'))::int as active,
                    count(*) filter (where status not in ('cancelled', 'missed') and order_by is null)::int as active_without_time,
                    max(greatest(order_by, cancel_by)) filter (where status not in ('cancelled', 'missed')) as active_latest,
                    max(greatest(order_by, cancel_by)) as any_latest
             from orders where delivery_date = $1::date and delivery_method = 'local_delivery' group by delivery_slot_id
           ) per_window`
const toClosing = (row: Row): SlotClosing => ({ slotId: String(row.slot_id), closesAt: row.closes_at instanceof Date ? row.closes_at.toISOString() : row.closes_at ? String(row.closes_at) : null, orderCount: Number(row.order_count) })
const text = (value: unknown) => (value == null ? '' : String(value))

export function createProductionPlanRepository(database: Database): ProductionPlanRepository {
  return {
    async demandFor(date) {
      const [demand, closings] = await Promise.all([
        database.query<Row>(
          `select o.delivery_slot_id as slot_id, coalesce(ds.name, o.slot_name) as slot_name, to_char(coalesce(ds.start_time, o.slot_start_time), 'HH24:MI') as start_time, to_char(coalesce(ds.end_time, o.slot_end_time), 'HH24:MI') as end_time,
                  i.product_id, (array_agg(i.product_name order by o.placed_at desc))[1] as product_name, i.variant_id, (array_agg(i.variant_name order by o.placed_at desc))[1] as variant_name, i.production_unit,
                  coalesce(sum(i.quantity) filter (where o.status <> 'cancelled'), 0)::int as quantity,
                  count(distinct o.id) filter (where o.status <> 'cancelled')::int as order_count,
                  coalesce(sum(i.quantity * i.production_quantity) filter (where o.status <> 'cancelled'), 0)::float8 as production_quantity,
                  coalesce(sum(i.quantity) filter (where o.status <> 'cancelled' and i.purchase_method = 'buy_once'), 0)::int as one_time,
                  coalesce(sum(i.quantity) filter (where o.status <> 'cancelled' and i.purchase_method = 'trial'), 0)::int as trial,
                  coalesce(sum(i.quantity) filter (where o.status <> 'cancelled' and i.purchase_method = 'subscription'), 0)::int as subscription,
                  coalesce(sum(i.quantity) filter (where o.status = 'cancelled'), 0)::int as cancelled_quantity
           from orders o join order_items i on i.order_id = o.id left join delivery_slots ds on ds.id = o.delivery_slot_id
           where o.delivery_date = $1::date and o.delivery_method = 'local_delivery' and o.status <> 'missed' and i.include_in_production_planning
           group by o.delivery_slot_id, coalesce(ds.name, o.slot_name), coalesce(ds.start_time, o.slot_start_time), coalesce(ds.end_time, o.slot_end_time), i.product_id, i.variant_id, i.production_unit
           order by start_time, product_name, variant_name`,
          [date],
        ),
        database.query<Row>(CLOSINGS_SQL, [date]),
      ])
      return {
        rows: demand.rows.map((row): DemandRow => ({
          slotId: String(row.slot_id), slotName: String(row.slot_name), startTime: String(row.start_time), endTime: String(row.end_time),
          productId: String(row.product_id), productName: String(row.product_name), variantId: String(row.variant_id), variantName: String(row.variant_name),
          quantity: Number(row.quantity), orderCount: Number(row.order_count), productionUnit: String(row.production_unit), productionQuantity: Number(row.production_quantity),
          byType: { oneTime: Number(row.one_time), trial: Number(row.trial), subscription: Number(row.subscription) }, cancelledQuantity: Number(row.cancelled_quantity),
        })),
        closings: closings.rows.map(toClosing),
      }
    },

    async riderStopsFor(date, slotId) {
      const [slots, stops, closings] = await Promise.all([
        database.query<Row>("select id, name, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time from delivery_slots where id = $1", [slotId]),
        database.query<Row>(
          `select o.id, o.order_number, o.recipient_name, o.recipient_phone, o.address_line1, o.address_line2, o.landmark, o.city, o.pin_code, o.doorstep_note,
                  case when o.subscription_id is null then 'one_time' when bool_or(i.purchase_method = 'trial') then 'trial' else 'subscription' end as kind,
                  json_agg(json_build_object('productId', i.product_id, 'variantId', i.variant_id, 'productName', i.product_name, 'variantName', i.variant_name, 'quantity', i.quantity) order by i.product_name, i.variant_name) as items
           from orders o join order_items i on i.order_id = o.id
           where o.delivery_date = $1::date and o.delivery_slot_id = $2 and o.delivery_method = 'local_delivery' and o.status in ('placed', 'out_for_delivery')
           group by o.id
           order by o.pin_code, o.id
           limit $3`,
          [date, slotId, RIDER_SHEET_LIMIT + 1],
        ),
        database.query<Row>(CLOSINGS_SQL, [date]),
      ])
      const slot = slots.rows[0]
      const closing = closings.rows.map(toClosing).find(entry => entry.slotId === slotId) ?? null
      return {
        slot: slot ? { slotId: String(slot.id), name: String(slot.name), startTime: String(slot.start_time), endTime: String(slot.end_time) } : null,
        stops: stops.rows.slice(0, RIDER_SHEET_LIMIT).map((row): RiderStopRow => ({
          orderId: String(row.id), orderNumber: String(row.order_number), recipientName: text(row.recipient_name), recipientPhone: text(row.recipient_phone),
          addressLine1: text(row.address_line1), addressLine2: text(row.address_line2), landmark: text(row.landmark), city: text(row.city), pinCode: text(row.pin_code), doorstepNote: text(row.doorstep_note),
          kind: row.kind as RiderStopRow['kind'],
          items: (row.items as Array<Record<string, unknown>>).map(item => ({ productId: String(item.productId), variantId: String(item.variantId), productName: String(item.productName), variantName: String(item.variantName), quantity: Number(item.quantity) })),
        })),
        closing, truncated: stops.rows.length > RIDER_SHEET_LIMIT,
      }
    },
  }
}
