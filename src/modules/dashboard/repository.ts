import type { Database } from '../../db/pool.js'
import { addDays } from '../delivery-brain/rules.js'

export type OrderCounts = { placed: number; out_for_delivery: number; delivered: number; missed: number; cancelled: number }

/** Orders placed and their value on one India day. Cancelled orders are not sales. */
export type TrendDay = { date: string; orders: number; revenuePaise: number }
/** How one delivery window is going today. */
export type WindowProgress = { slotId: string; name: string; startTime: string; endTime: string; total: number; delivered: number; outForDelivery: number; missed: number }
export type TopProduct = { name: string; quantity: number; revenuePaise: number }
export type RecentOrder = { id: string; orderNumber: string; customerName: string; totalPaise: number; status: string; placedAt: string }

export type DashboardData = {
  today: string
  tomorrow: string
  deliveries: { today: OrderCounts; todayTotal: number; tomorrowTotal: number }
  plans: { subscriptions: number; trials: number }
  money: { owedPaise: number; owingCustomers: number; refundsToSend: number; refundsToSendPaise: number; paidOnlineTodayPaise: number }
  customers: { active: number; newThisWeek: number; newPreviousWeek: number }
  /** Sales by the day the order was placed, for the last 14 days (oldest first, days with no orders included as zero). */
  sales: { todayPaise: number; yesterdayPaise: number; todayOrders: number; yesterdayOrders: number; last7Paise: number; previous7Paise: number; last7Orders: number; previous7Orders: number; trend: TrendDay[] }
  /** Of the last 7 delivery days' orders that reached an end state: how many were delivered and how many missed. */
  deliveryQuality: { delivered7: number; missed7: number }
  windows: WindowProgress[]
  topProducts: TopProduct[]
  recentOrders: RecentOrder[]
  /** Things staff should look at: each is a count, zero meaning nothing to do. */
  attention: { creditLimitSkips: number; overdueOrders: number; openTickets: number }
}

/** Read-only roll-ups for the landing page. The Postgres version below is the real one; tests use a fake. */
export interface DashboardRepository {
  summary(today: string, tomorrow: string): Promise<Omit<DashboardData, 'today' | 'tomorrow'>>
}

type Row = Record<string, unknown>
const num = (value: unknown) => Number(value ?? 0)

export function createDashboardRepository(database: Database): DashboardRepository {
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => ((await database.query<Row>(sql, params)).rows[0] ?? {})
  return {
    async summary(today, tomorrow) {
      const [byStatus, tomorrowRow, plans, owed, refunds, paid, customers, skips, overdue, tickets, salesDays, quality, windows, topProducts, recent] = await Promise.all([
        database.query<Row>('select status, count(*)::int as count from orders where delivery_date = $1::date group by status', [today]),
        one("select count(*)::int as count from orders where delivery_date = $1::date and status <> 'cancelled'", [tomorrow]),
        database.query<Row>("select kind, count(*)::int as count from subscriptions where status = 'active' group by kind"),
        // What credit customers owe: for each customer, debits minus credits, counting only those who owe something.
        one(`select coalesce(sum(balance), 0)::bigint as owed, count(*)::int as customers from (
               select sum(case when direction = 'debit' then amount_paise else -amount_paise end) as balance from credit_ledger_entries group by customer_id
             ) per_customer where balance > 0`),
        one("select count(*)::int as count, coalesce(sum(amount_paise), 0)::bigint as paise from prepaid_adjustments where adjustment_type = 'refund_pending' and status = 'pending'"),
        one("select coalesce(sum(amount_paise), 0)::bigint as paise from payments where status in ('paid', 'partially_refunded') and (paid_at at time zone 'Asia/Kolkata')::date = $1::date", [today]),
        one(`select count(*) filter (where status = 'active')::int as active,
                    count(*) filter (where status = 'active' and created_at >= now() - interval '7 days')::int as new_week,
                    count(*) filter (where status = 'active' and created_at >= now() - interval '14 days' and created_at < now() - interval '7 days')::int as new_previous_week
             from customers`),
        one("select count(*)::int as count from subscription_skips where reason = 'credit_limit' and delivery_date >= $1::date", [today]),
        one("select count(*)::int as count from orders where delivery_date < $1::date and status in ('placed', 'out_for_delivery')", [today]),
        one("select count(*)::int as count from support_tickets where status in ('open', 'in_progress')"),
        // Sales per India day for the last 14 days, by when the order was placed.
        database.query<Row>(
          `select (placed_at at time zone 'Asia/Kolkata')::date::text as day, count(*)::int as orders, coalesce(sum(total_paise), 0)::bigint as paise
           from orders where status <> 'cancelled' and (placed_at at time zone 'Asia/Kolkata')::date > $1::date - 14
           group by 1`,
          [today],
        ),
        one("select count(*) filter (where status = 'delivered')::int as delivered, count(*) filter (where status = 'missed')::int as missed from orders where delivery_date > $1::date - 7 and delivery_date <= $1::date", [today]),
        database.query<Row>(
          `select s.id, s.name, to_char(s.start_time, 'HH24:MI') as start_time, to_char(s.end_time, 'HH24:MI') as end_time,
                  count(*)::int as total, count(*) filter (where o.status = 'delivered')::int as delivered,
                  count(*) filter (where o.status = 'out_for_delivery')::int as out_for_delivery, count(*) filter (where o.status = 'missed')::int as missed
           from orders o join delivery_slots s on s.id = o.delivery_slot_id
           where o.delivery_date = $1::date and o.status <> 'cancelled'
           group by s.id, s.name, s.start_time, s.end_time order by s.start_time`,
          [today],
        ),
        database.query<Row>(
          `select i.product_name as name, sum(i.quantity)::int as quantity, coalesce(sum(i.line_total_paise), 0)::bigint as paise
           from order_items i join orders o on o.id = i.order_id
           where o.status <> 'cancelled' and (o.placed_at at time zone 'Asia/Kolkata')::date > $1::date - 7
           group by i.product_name order by paise desc, quantity desc limit 5`,
          [today],
        ),
        database.query<Row>('select id, order_number, recipient_name, total_paise, status, placed_at from orders order by placed_at desc limit 6'),
      ])
      const counts: OrderCounts = { placed: 0, out_for_delivery: 0, delivered: 0, missed: 0, cancelled: 0 }
      for (const row of byStatus.rows) if (String(row.status) in counts) counts[String(row.status) as keyof OrderCounts] = num(row.count)
      const planCount = (kind: string) => num(plans.rows.find(row => row.kind === kind)?.count)
      const byDay = new Map(salesDays.rows.map(row => [String(row.day), { orders: num(row.orders), paise: num(row.paise) }]))
      const trend: TrendDay[] = Array.from({ length: 14 }, (_, index) => {
        const date = addDays(today, index - 13)
        const day = byDay.get(date)
        return { date, orders: day?.orders ?? 0, revenuePaise: day?.paise ?? 0 }
      })
      const sum = (days: TrendDay[], field: 'orders' | 'revenuePaise') => days.reduce((total, day) => total + day[field], 0)
      const last7 = trend.slice(7)
      const previous7 = trend.slice(0, 7)
      return {
        deliveries: { today: counts, todayTotal: counts.placed + counts.out_for_delivery + counts.delivered + counts.missed, tomorrowTotal: num(tomorrowRow.count) },
        plans: { subscriptions: planCount('subscription'), trials: planCount('trial') },
        money: { owedPaise: num(owed.owed), owingCustomers: num(owed.customers), refundsToSend: num(refunds.count), refundsToSendPaise: num(refunds.paise), paidOnlineTodayPaise: num(paid.paise) },
        customers: { active: num(customers.active), newThisWeek: num(customers.new_week), newPreviousWeek: num(customers.new_previous_week) },
        sales: {
          todayPaise: trend[13]?.revenuePaise ?? 0, yesterdayPaise: trend[12]?.revenuePaise ?? 0, todayOrders: trend[13]?.orders ?? 0, yesterdayOrders: trend[12]?.orders ?? 0,
          last7Paise: sum(last7, 'revenuePaise'), previous7Paise: sum(previous7, 'revenuePaise'), last7Orders: sum(last7, 'orders'), previous7Orders: sum(previous7, 'orders'), trend,
        },
        deliveryQuality: { delivered7: num(quality.delivered), missed7: num(quality.missed) },
        windows: windows.rows.map((row): WindowProgress => ({ slotId: String(row.id), name: String(row.name), startTime: String(row.start_time), endTime: String(row.end_time), total: num(row.total), delivered: num(row.delivered), outForDelivery: num(row.out_for_delivery), missed: num(row.missed) })),
        topProducts: topProducts.rows.map((row): TopProduct => ({ name: String(row.name), quantity: num(row.quantity), revenuePaise: num(row.paise) })),
        recentOrders: recent.rows.map((row): RecentOrder => ({ id: String(row.id), orderNumber: String(row.order_number), customerName: String(row.recipient_name ?? ''), totalPaise: num(row.total_paise), status: String(row.status), placedAt: new Date(String(row.placed_at)).toISOString() })),
        attention: { creditLimitSkips: num(skips.count), overdueOrders: num(overdue.count), openTickets: num(tickets.count) },
      }
    },
  }
}
