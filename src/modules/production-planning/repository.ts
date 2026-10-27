import type { Database } from '../../db/pool.js'
import type { DemandRow, SlotClosing } from './rules.js'

/** What production planning reads. The Postgres version below is the real one; tests use a fake. */
export interface ProductionPlanRepository {
  /**
   * Demand for one delivery day: own-delivery orders still wanted (not cancelled or missed), only items of products marked
   * "include in production planning", added up per window, product and size, and split by one-time, trial and subscription.
   * Cancelled (or skipped) pieces are counted separately so staff see what dropped out. Reads the figures saved on each item.
   */
  demandFor(date: string): Promise<{ rows: DemandRow[]; closings: SlotClosing[] }>
}

type Row = Record<string, unknown>

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
        database.query<Row>(
          `select slot_id,
                  -- The window is final when nothing in it can change any more: after the order-by time (no new orders) AND the cancel-by time (no cancellations),
                  -- whichever is later, for each order. If every order in it was cancelled, the cancelled ones still tell when it closes.
                  case when active > 0 then (case when active_without_time > 0 then null else active_latest end) else any_latest end as closes_at,
                  active as order_count
           from (
             select delivery_slot_id as slot_id,
                    count(*) filter (where status not in ('cancelled', 'missed'))::int as active,
                    count(*) filter (where status not in ('cancelled', 'missed') and order_by is null)::int as active_without_time,
                    max(greatest(order_by, cancel_by)) filter (where status not in ('cancelled', 'missed')) as active_latest,
                    max(greatest(order_by, cancel_by)) as any_latest
             from orders where delivery_date = $1::date and delivery_method = 'local_delivery' group by delivery_slot_id
           ) per_window`,
          [date],
        ),
      ])
      return {
        rows: demand.rows.map((row): DemandRow => ({
          slotId: String(row.slot_id), slotName: String(row.slot_name), startTime: String(row.start_time), endTime: String(row.end_time),
          productId: String(row.product_id), productName: String(row.product_name), variantId: String(row.variant_id), variantName: String(row.variant_name),
          quantity: Number(row.quantity), orderCount: Number(row.order_count), productionUnit: String(row.production_unit), productionQuantity: Number(row.production_quantity),
          byType: { oneTime: Number(row.one_time), trial: Number(row.trial), subscription: Number(row.subscription) }, cancelledQuantity: Number(row.cancelled_quantity),
        })),
        closings: closings.rows.map((row): SlotClosing => ({ slotId: String(row.slot_id), closesAt: row.closes_at instanceof Date ? row.closes_at.toISOString() : row.closes_at ? String(row.closes_at) : null, orderCount: Number(row.order_count) })),
      }
    },
  }
}
