import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { likePattern } from '../master-data/shared.js'
import type { TicketCategory, TicketListQuery, TicketStatus } from './schema.js'

export type TicketMessage = { id: string; author: 'customer' | 'admin'; authorName: string; body: string; createdAt: string }

/** One ticket as staff see it, with who raised it and who is looking after it. */
export type SupportTicket = {
  id: string
  ticketNumber: number
  customerId: string
  customerName: string
  customerPhone: string | null
  category: TicketCategory
  status: TicketStatus
  assigneeAdminId: string | null
  assigneeEmail: string | null
  messageCount: number
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
}

export type TicketThread = { ticket: SupportTicket; messages: TicketMessage[] }

export interface SupportTicketRepository {
  /** Creates the ticket and its first message together. */
  create(input: { customerId: string; category: TicketCategory; description: string }): Promise<SupportTicket>
  countRecentForCustomer(customerId: string, since: Date): Promise<number>
  list(query: TicketListQuery & { forCustomerId?: string }): Promise<{ rows: SupportTicket[]; total: number }>
  getThread(id: string, forCustomerId?: string): Promise<TicketThread | null>
  /** Adds a message and moves the ticket on when the rules say so. Null when the ticket does not exist. */
  addMessage(input: { ticketId: string; author: 'customer' | 'admin'; adminId: string | null; body: string; nextStatus: TicketStatus | null }): Promise<boolean>
  setStatus(id: string, status: TicketStatus, now: Date): Promise<boolean>
  setAssignee(id: string, adminId: string | null): Promise<boolean>
  /** Counts that still need staff attention (open and in progress). */
  countNeedingAttention(): Promise<number>
}

type Row = Record<string, unknown>
const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString()
const isoOrNull = (value: unknown): string | null => (value ? iso(value) : null)

const TICKET_SELECT = `
  t.id, t.ticket_number, t.customer_id, c.name as customer_name, coalesce(c.phone, nullif(c.email, '')) as customer_phone, t.category, t.status,
  t.assignee_admin_id, a.email as assignee_email, t.created_at, t.updated_at, t.resolved_at, t.closed_at,
  (select count(*)::int from support_ticket_messages m where m.ticket_id = t.id) as message_count`
const TICKET_FROM = `from support_tickets t join customers c on c.id = t.customer_id left join admin_users a on a.id = t.assignee_admin_id`

const toTicket = (row: Row): SupportTicket => ({
  id: String(row.id),
  ticketNumber: Number(row.ticket_number),
  customerId: String(row.customer_id),
  customerName: String(row.customer_name),
  customerPhone: row.customer_phone === null ? null : String(row.customer_phone),
  category: String(row.category) as TicketCategory,
  status: String(row.status) as TicketStatus,
  assigneeAdminId: row.assignee_admin_id === null ? null : String(row.assignee_admin_id),
  assigneeEmail: row.assignee_email === null ? null : String(row.assignee_email),
  messageCount: Number(row.message_count),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  resolvedAt: isoOrNull(row.resolved_at),
  closedAt: isoOrNull(row.closed_at),
})

export function createSupportTicketRepository(database: Database): SupportTicketRepository {
  async function findTicket(id: string): Promise<SupportTicket | null> {
    const { rows } = await database.query<Row>(`select ${TICKET_SELECT} ${TICKET_FROM} where t.id = $1`, [id])
    return rows[0] ? toTicket(rows[0]) : null
  }

  return {
    create: ({ customerId, category, description }) => withTransaction(database, async client => {
      const inserted = await client.query<Row>('insert into support_tickets (customer_id, category) values ($1, $2) returning id', [customerId, category])
      const id = String((inserted.rows[0] as Row).id)
      await client.query("insert into support_ticket_messages (ticket_id, author, body) values ($1, 'customer', $2)", [id, description])
      const { rows } = await client.query<Row>(`select ${TICKET_SELECT} ${TICKET_FROM} where t.id = $1`, [id])
      return toTicket(rows[0] as Row)
    }),

    async countRecentForCustomer(customerId, since) {
      const { rows } = await database.query<Row>('select count(*)::int as count from support_tickets where customer_id = $1 and created_at > $2', [customerId, since])
      return Number(rows[0]?.count ?? 0)
    },

    async list({ search, status, category, customerId, forCustomerId, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${TICKET_SELECT}, count(*) over() as total ${TICKET_FROM}
         where ($1::text is null or t.status = $1) and ($2::text is null or t.category = $2) and ($3::uuid is null or t.customer_id = $3)
           and ($4::uuid is null or t.customer_id = $4)
           and ($5::text is null or c.name ilike $5 or c.phone ilike $5 or c.email ilike $5 or ('TKT-' || t.ticket_number::text) ilike $5)
         order by t.updated_at desc, t.ticket_number desc limit $6 offset $7`,
        [status ?? null, category ?? null, customerId ?? null, forCustomerId ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toTicket), total: rows[0] ? Number(rows[0].total) : 0 }
    },

    async getThread(id, forCustomerId) {
      const ticket = await findTicket(id)
      if (!ticket || (forCustomerId !== undefined && ticket.customerId !== forCustomerId)) return null
      const { rows } = await database.query<Row>(
        `select m.id, m.author, m.body, m.created_at, a.email as admin_email from support_ticket_messages m left join admin_users a on a.id = m.admin_id where m.ticket_id = $1 order by m.created_at, m.id`,
        [id],
      )
      const messages = rows.map((row): TicketMessage => ({
        id: String(row.id),
        author: row.author === 'admin' ? 'admin' : 'customer',
        // A customer sees "ShreeRam Milks support", never a staff member's email.
        authorName: row.author === 'admin' ? (row.admin_email ? String(row.admin_email) : 'Support') : ticket.customerName,
        body: String(row.body),
        createdAt: iso(row.created_at),
      }))
      return { ticket, messages }
    },

    addMessage: ({ ticketId, author, adminId, body, nextStatus }) => withTransaction(database, async client => {
      const exists = await client.query('select 1 from support_tickets where id = $1 for update', [ticketId])
      if (exists.rowCount === 0) return false
      await client.query('insert into support_ticket_messages (ticket_id, author, admin_id, body) values ($1, $2, $3, $4)', [ticketId, author, adminId, body])
      await client.query(
        "update support_tickets set updated_at = now(), status = coalesce($2, status), resolved_at = case when $2 in ('open', 'in_progress') then null else resolved_at end where id = $1",
        [ticketId, nextStatus],
      )
      return true
    }),

    async setStatus(id, status, now) {
      const result = await database.query(
        `update support_tickets set status = $2, updated_at = $3,
           resolved_at = case when $2 = 'resolved' then $3 when $2 in ('open', 'in_progress') then null else resolved_at end,
           closed_at = case when $2 = 'closed' then $3 else closed_at end where id = $1`,
        [id, status, now],
      )
      return (result.rowCount ?? 0) === 1
    },

    async setAssignee(id, adminId) {
      const result = await database.query('update support_tickets set assignee_admin_id = $2, updated_at = now() where id = $1', [id, adminId])
      return (result.rowCount ?? 0) === 1
    },

    async countNeedingAttention() {
      const { rows } = await database.query<Row>("select count(*)::int as count from support_tickets where status in ('open', 'in_progress')")
      return Number(rows[0]?.count ?? 0)
    },
  }
}
