import type { Database } from '../../db/pool.js'

export type RiderSession = { sessionId: string; adminId: string; email: string }
export type NewRiderSession = { adminId: string; tokenHash: string; expiresAt: Date; userAgent: string | null; ip: string | null }
/** One delivery window of a day, with how its orders stand. Only local deliveries are counted: the rider does not carry courier parcels. */
export type RiderWindow = { slotId: string; name: string; startTime: string; endTime: string; open: number; delivered: number; missed: number; pins: number }
export type CheckIn = { pinCode: string; checkedInAt: string; customersNotified: number }
/** A house already finished in this window (delivered or missed): it stays on the rider's list with its status. */
export type ClosedStop = {
  orderId: string; orderNumber: string; recipientName: string; addressLine1: string; addressLine2: string; pinCode: string
  status: 'delivered' | 'missed'; closedAt: string; items: Array<{ productName: string; variantName: string; quantity: number }>
}
/** A customer with an open order in one PIN code, with the order the message will name. */
export type WaitingCustomer = { customerId: string; orderId: string; orderNumber: string }

/** Everything the rider feature needs from storage. The Postgres version below is the real one; tests use a fake. */
export interface RiderRepository {
  createSession(session: NewRiderSession): Promise<void>
  findSession(tokenHash: string, now: Date): Promise<RiderSession | null>
  touchSession(sessionId: string, now: Date): Promise<void>
  revokeSession(tokenHash: string, now: Date): Promise<void>
  windows(date: string): Promise<RiderWindow[]>
  checkIns(date: string, slotId: string): Promise<CheckIn[]>
  /** Writes the check-in. Returns its id, or null when this PIN was already checked in for this window and day (nobody is told twice). */
  recordCheckIn(input: { adminId: string; date: string; slotId: string; pinCode: string }): Promise<string | null>
  setNotified(checkInId: string, customers: number): Promise<void>
  waitingCustomers(date: string, slotId: string, pinCode: string): Promise<WaitingCustomer[]>
  /** Delivered and missed local deliveries of one window, latest first. */
  closedStops(date: string, slotId: string): Promise<ClosedStop[]>
}

/** The most finished houses one window lists. */
const CLOSED_LIMIT = 1000

type Row = Record<string, unknown>
const OPEN = "('placed', 'out_for_delivery')"

export function createRiderRepository(database: Database): RiderRepository {
  return {
    async createSession({ adminId, tokenHash, expiresAt, userAgent, ip }) {
      await database.query('insert into rider_sessions (admin_user_id, token_hash, expires_at, user_agent, ip_address) values ($1, $2, $3, $4, $5)', [adminId, tokenHash, expiresAt, userAgent, ip])
    },
    async findSession(tokenHash, now) {
      const { rows } = await database.query<Row>(
        `select s.id as session_id, s.admin_user_id, u.email from rider_sessions s join admin_users u on u.id = s.admin_user_id
         where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and u.status = 'active'`,
        [tokenHash, now],
      )
      const row = rows[0]
      return row ? { sessionId: String(row.session_id), adminId: String(row.admin_user_id), email: String(row.email) } : null
    },
    async touchSession(sessionId, now) {
      await database.query('update rider_sessions set last_seen_at = $2 where id = $1', [sessionId, now])
    },
    async revokeSession(tokenHash, now) {
      await database.query('update rider_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null', [tokenHash, now])
    },

    async windows(date) {
      const { rows } = await database.query<Row>(
        `select s.id, s.name, to_char(s.start_time, 'HH24:MI') as start_time, to_char(s.end_time, 'HH24:MI') as end_time,
                count(o.id) filter (where o.status in ${OPEN})::int as open,
                count(o.id) filter (where o.status = 'delivered')::int as delivered,
                count(o.id) filter (where o.status = 'missed')::int as missed,
                count(distinct o.pin_code) filter (where o.status in ${OPEN})::int as pins
           from delivery_slots s
           left join orders o on o.delivery_slot_id = s.id and o.delivery_date = $1::date and o.delivery_method = 'local_delivery'
          where s.status = 'active'
          group by s.id
          order by s.start_time, s.name`,
        [date],
      )
      return rows.map(row => ({ slotId: String(row.id), name: String(row.name), startTime: String(row.start_time), endTime: String(row.end_time), open: Number(row.open), delivered: Number(row.delivered), missed: Number(row.missed), pins: Number(row.pins) }))
    },

    async checkIns(date, slotId) {
      const { rows } = await database.query<Row>('select pin_code, checked_in_at, customers_notified from rider_checkins where delivery_date = $1::date and delivery_slot_id = $2 order by checked_in_at', [date, slotId])
      return rows.map(row => ({ pinCode: String(row.pin_code), checkedInAt: row.checked_in_at instanceof Date ? row.checked_in_at.toISOString() : String(row.checked_in_at), customersNotified: Number(row.customers_notified) }))
    },
    async recordCheckIn({ adminId, date, slotId, pinCode }) {
      const { rows } = await database.query<Row>(
        'insert into rider_checkins (admin_user_id, delivery_date, delivery_slot_id, pin_code) values ($1, $2::date, $3, $4) on conflict (delivery_date, delivery_slot_id, pin_code) do nothing returning id',
        [adminId, date, slotId, pinCode],
      )
      return rows[0] ? String(rows[0].id) : null
    },
    async setNotified(checkInId, customers) {
      await database.query('update rider_checkins set customers_notified = $2 where id = $1', [checkInId, customers])
    },
    async waitingCustomers(date, slotId, pinCode) {
      const { rows } = await database.query<Row>(
        `select distinct on (o.customer_id) o.customer_id, o.id as order_id, o.order_number
           from orders o
          where o.delivery_date = $1::date and o.delivery_slot_id = $2 and o.pin_code = $3 and o.delivery_method = 'local_delivery' and o.status in ${OPEN}
          order by o.customer_id, o.order_number`,
        [date, slotId, pinCode],
      )
      return rows.map(row => ({ customerId: String(row.customer_id), orderId: String(row.order_id), orderNumber: String(row.order_number) }))
    },
    async closedStops(date, slotId) {
      const { rows } = await database.query<Row>(
        `select o.id, o.order_number, o.recipient_name, o.address_line1, o.address_line2, o.pin_code, o.status, o.updated_at,
                json_agg(json_build_object('productName', i.product_name, 'variantName', i.variant_name, 'quantity', i.quantity) order by i.product_name, i.variant_name) as items
           from orders o join order_items i on i.order_id = o.id
          where o.delivery_date = $1::date and o.delivery_slot_id = $2 and o.delivery_method = 'local_delivery' and o.status in ('delivered', 'missed')
          group by o.id
          order by o.updated_at desc
          limit $3`,
        [date, slotId, CLOSED_LIMIT],
      )
      return rows.map(row => ({
        orderId: String(row.id), orderNumber: String(row.order_number), recipientName: String(row.recipient_name ?? ''), addressLine1: String(row.address_line1 ?? ''),
        addressLine2: String(row.address_line2 ?? ''), pinCode: String(row.pin_code ?? ''), status: row.status as ClosedStop['status'],
        closedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        items: (row.items as Array<Record<string, unknown>>).map(item => ({ productName: String(item.productName), variantName: String(item.variantName), quantity: Number(item.quantity) })),
      }))
    },
  }
}
