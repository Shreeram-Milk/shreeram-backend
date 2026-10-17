import type { Database } from '../../db/pool.js'

export type OrderCounts = { placed: number; out_for_delivery: number; delivered: number; missed: number; cancelled: number }

export type DashboardData = {
  today: string
  tomorrow: string
  deliveries: { today: OrderCounts; todayTotal: number; tomorrowTotal: number }
  plans: { subscriptions: number; trials: number }
  money: { owedPaise: number; owingCustomers: number; refundsToSend: number; refundsToSendPaise: number; paidOnlineTodayPaise: number }
  customers: { active: number; newThisWeek: number }
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
      const [byStatus, tomorrowRow, plans, owed, refunds, paid, customers, skips, overdue, tickets] = await Promise.all([
        database.query<Row>('select status, count(*)::int as count from orders where delivery_date = $1::date group by status', [today]),
        one("select count(*)::int as count from orders where delivery_date = $1::date and status <> 'cancelled'", [tomorrow]),
        database.query<Row>("select kind, count(*)::int as count from subscriptions where status = 'active' group by kind"),
        // What credit customers owe: for each customer, debits minus credits, counting only those who owe something.
        one(`select coalesce(sum(balance), 0)::bigint as owed, count(*)::int as customers from (
               select sum(case when direction = 'debit' then amount_paise else -amount_paise end) as balance from credit_ledger_entries group by customer_id
             ) per_customer where balance > 0`),
        one("select count(*)::int as count, coalesce(sum(amount_paise), 0)::bigint as paise from prepaid_adjustments where adjustment_type = 'refund_pending' and status = 'pending'"),
        one("select coalesce(sum(amount_paise), 0)::bigint as paise from payments where status in ('paid', 'partially_refunded') and (paid_at at time zone 'Asia/Kolkata')::date = $1::date", [today]),
        one("select count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'active' and created_at >= now() - interval '7 days')::int as new_week from customers"),
        one("select count(*)::int as count from subscription_skips where reason = 'credit_limit' and delivery_date >= $1::date", [today]),
        one("select count(*)::int as count from orders where delivery_date < $1::date and status in ('placed', 'out_for_delivery')", [today]),
        one("select count(*)::int as count from support_tickets where status in ('open', 'in_progress')"),
      ])
      const counts: OrderCounts = { placed: 0, out_for_delivery: 0, delivered: 0, missed: 0, cancelled: 0 }
      for (const row of byStatus.rows) if (String(row.status) in counts) counts[String(row.status) as keyof OrderCounts] = num(row.count)
      const planCount = (kind: string) => num(plans.rows.find(row => row.kind === kind)?.count)
      return {
        deliveries: { today: counts, todayTotal: counts.placed + counts.out_for_delivery + counts.delivered + counts.missed, tomorrowTotal: num(tomorrowRow.count) },
        plans: { subscriptions: planCount('subscription'), trials: planCount('trial') },
        money: { owedPaise: num(owed.owed), owingCustomers: num(owed.customers), refundsToSend: num(refunds.count), refundsToSendPaise: num(refunds.paise), paidOnlineTodayPaise: num(paid.paise) },
        customers: { active: num(customers.active), newThisWeek: num(customers.new_week) },
        attention: { creditLimitSkips: num(skips.count), overdueOrders: num(overdue.count), openTickets: num(tickets.count) },
      }
    },
  }
}
