import type { Database } from '../../db/pool.js'
import type { NotificationEventKey } from './events.js'
import type { Language, Wording } from './rules.js'
import type { Audience, BroadcastListQuery, NotificationListQuery, RegisterTokenInput, TemplateUpdateInput } from './schema.js'

export type Template = Wording & { event: NotificationEventKey; enabled: boolean; updatedAt: string }

export type StoredNotification = Wording & {
  id: string; event: NotificationEventKey | 'broadcast'; link: string | null; broadcastId: string | null; createdAt: string; readAt: string | null
}
export type NewNotification = Wording & { customerId: string; event: NotificationEventKey; link: string | null; dedupeKey: string }

export type Broadcast = Wording & {
  id: string; audience: Audience; recipients: number; pushed: number; status: 'sending' | 'sent' | 'failed'; createdAt: string; finishedAt: string | null
}

export type CustomerBrief = { id: string; language: Language; active: boolean }
export type Recipient = { customerId: string; language: Language }

/** Storage for notifications. The Postgres version below is the real one; tests use a fake. */
export interface NotificationRepository {
  upsertToken(customerId: string, input: RegisterTokenInput): Promise<void>
  /** The language messages to this customer are written in (what they chose in the app). */
  setLanguage(customerId: string, language: Language): Promise<void>
  removeToken(customerId: string, token: string): Promise<void>
  deactivateTokens(tokens: string[]): Promise<void>
  /** The active phones of each customer (a customer with none is absent from the result). */
  tokensFor(customerIds: string[]): Promise<Map<string, string[]>>
  customerBrief(customerId: string): Promise<CustomerBrief | null>

  listTemplates(): Promise<Template[]>
  getTemplate(event: NotificationEventKey): Promise<Template | null>
  updateTemplate(event: NotificationEventKey, input: TemplateUpdateInput, adminId: string): Promise<Template | null>

  /** Stores one message for the bell. Null when the same occurrence (same dedupe key) was already stored: nothing is sent again. */
  addNotification(input: NewNotification): Promise<StoredNotification | null>
  /** Stores a broadcast's message for each customer, once each. Returns the customers it was newly stored for. */
  addBroadcastNotifications(broadcastId: string, customerIds: string[], wording: Wording, link: string): Promise<string[]>
  listFor(customerId: string, query: NotificationListQuery): Promise<{ notifications: StoredNotification[]; total: number; unread: number }>
  unreadCount(customerId: string): Promise<number>
  markRead(customerId: string, id: string): Promise<boolean>
  markAllRead(customerId: string): Promise<number>

  /** Active customers matching the audience, with the language each reads. */
  resolveAudience(audience: Audience): Promise<Recipient[]>
  countAudience(audience: Audience): Promise<{ customers: number; withDevices: number }>
  createBroadcast(input: Wording & { audience: Audience }, adminId: string): Promise<Broadcast>
  finishBroadcast(id: string, result: { recipients: number; pushed: number; status: 'sent' | 'failed' }): Promise<void>
  listBroadcasts(query: BroadcastListQuery): Promise<{ rows: Broadcast[]; total: number }>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const isoOrNull = (value: unknown) => (value === null || value === undefined ? null : iso(value))
const CHUNK = 1000

const templateOf = (row: Row): Template => ({
  event: String(row.event_key) as NotificationEventKey, title: String(row.title), titleGujarati: String(row.title_gu), body: String(row.body), bodyGujarati: String(row.body_gu),
  enabled: Boolean(row.enabled), updatedAt: iso(row.updated_at),
})
const notificationOf = (row: Row): StoredNotification => ({
  id: String(row.id), event: String(row.event_key) as StoredNotification['event'], title: String(row.title), titleGujarati: String(row.title_gu), body: String(row.body), bodyGujarati: String(row.body_gu),
  link: row.link ? String(row.link) : null, broadcastId: row.broadcast_id ? String(row.broadcast_id) : null, createdAt: iso(row.created_at), readAt: isoOrNull(row.read_at),
})
const broadcastOf = (row: Row): Broadcast => ({
  id: String(row.id), title: String(row.title), titleGujarati: String(row.title_gu), body: String(row.body), bodyGujarati: String(row.body_gu), audience: row.audience as Audience,
  recipients: Number(row.recipients), pushed: Number(row.pushed), status: String(row.status) as Broadcast['status'], createdAt: iso(row.created_at), finishedAt: isoOrNull(row.finished_at),
})
const TEMPLATE_COLUMNS = 'event_key, title, title_gu, body, body_gu, enabled, updated_at'
const NOTIFICATION_COLUMNS = 'id, event_key, title, title_gu, body, body_gu, link, broadcast_id, created_at, read_at'
const BROADCAST_COLUMNS = 'id, title, title_gu, body, body_gu, audience, recipients, pushed, status, created_at, finished_at'

/** The WHERE part that picks the customers of an audience. Blocked and deleted customers are never included. Values are always bound, never pasted in. */
export function audienceClause(audience: Audience): { where: string; params: unknown[] } {
  const parts = ["c.status = 'active'"]
  const params: unknown[] = []
  if (audience.type === 'customers') {
    params.push(audience.customerIds)
    parts.push(`c.id = any($${params.length}::uuid[])`)
  }
  if (audience.type === 'filter') {
    if (audience.customerType) { params.push(audience.customerType); parts.push(`c.customer_type = $${params.length}`) }
    if (audience.pinCodes && audience.pinCodes.length > 0) {
      params.push(audience.pinCodes)
      parts.push(`exists (select 1 from customer_addresses a where a.customer_id = c.id and a.removed_at is null and a.pin_code = any($${params.length}::text[]))`)
    }
    if (audience.hasActiveSubscription === true) parts.push("exists (select 1 from subscriptions s where s.customer_id = c.id and s.status = 'active')")
    if (audience.hasActiveSubscription === false) parts.push("not exists (select 1 from subscriptions s where s.customer_id = c.id and s.status = 'active')")
  }
  return { where: parts.join(' and '), params }
}

export function createNotificationRepository(database: Database): NotificationRepository {
  return {
    async upsertToken(customerId, { token, platform }) {
      // The same phone may have been used by another customer before: it now belongs to whoever signed in last.
      await database.query(
        `insert into push_tokens (customer_id, token, platform) values ($1, $2, $3)
         on conflict (token) do update set customer_id = excluded.customer_id, platform = excluded.platform, active = true, last_seen_at = now()`,
        [customerId, token, platform],
      )
    },
    async setLanguage(customerId, language) {
      await database.query("update customers set language = $2, updated_at = now() where id = $1 and language <> $2 and status = 'active'", [customerId, language])
    },
    async removeToken(customerId, token) {
      await database.query('update push_tokens set active = false where customer_id = $1 and token = $2', [customerId, token])
    },
    async deactivateTokens(tokens) {
      if (tokens.length > 0) await database.query('update push_tokens set active = false where token = any($1::text[])', [tokens])
    },
    async tokensFor(customerIds) {
      const result = new Map<string, string[]>()
      if (customerIds.length === 0) return result
      const { rows } = await database.query<Row>('select customer_id, token from push_tokens where active and customer_id = any($1::uuid[])', [customerIds])
      for (const row of rows) result.set(String(row.customer_id), [...(result.get(String(row.customer_id)) ?? []), String(row.token)])
      return result
    },
    async customerBrief(customerId) {
      const { rows } = await database.query<Row>('select id, language, status from customers where id = $1', [customerId])
      const row = rows[0]
      return row ? { id: String(row.id), language: row.language === 'gu' ? 'gu' : 'en', active: row.status === 'active' } : null
    },

    async listTemplates() {
      const { rows } = await database.query<Row>(`select ${TEMPLATE_COLUMNS} from notification_templates order by event_key`)
      return rows.map(templateOf)
    },
    async getTemplate(event) {
      const { rows } = await database.query<Row>(`select ${TEMPLATE_COLUMNS} from notification_templates where event_key = $1`, [event])
      return rows[0] ? templateOf(rows[0]) : null
    },
    async updateTemplate(event, input, adminId) {
      const { rows } = await database.query<Row>(
        `update notification_templates set title = $2, title_gu = $3, body = $4, body_gu = $5, enabled = $6, updated_at = now(), updated_by = $7 where event_key = $1 returning ${TEMPLATE_COLUMNS}`,
        [event, input.title, input.titleGujarati, input.body, input.bodyGujarati, input.enabled, adminId],
      )
      return rows[0] ? templateOf(rows[0]) : null
    },

    async addNotification(input) {
      const { rows } = await database.query<Row>(
        `insert into notifications (customer_id, event_key, title, title_gu, body, body_gu, link, dedupe_key) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (customer_id, dedupe_key) where dedupe_key is not null do nothing returning ${NOTIFICATION_COLUMNS}`,
        [input.customerId, input.event, input.title, input.titleGujarati, input.body, input.bodyGujarati, input.link, input.dedupeKey],
      )
      return rows[0] ? notificationOf(rows[0]) : null
    },
    async addBroadcastNotifications(broadcastId, customerIds, wording, link) {
      const stored: string[] = []
      for (let start = 0; start < customerIds.length; start += CHUNK) {
        const { rows } = await database.query<Row>(
          `insert into notifications (customer_id, event_key, title, title_gu, body, body_gu, broadcast_id, dedupe_key, link)
           select id, 'broadcast', $2, $3, $4, $5, $1::uuid, $7, $8 from unnest($6::uuid[]) as id
           on conflict (customer_id, dedupe_key) where dedupe_key is not null do nothing returning customer_id`,
          // The dedupe key is its own text value: reusing $1 as both uuid and text makes Postgres refuse the query.
          [broadcastId, wording.title, wording.titleGujarati, wording.body, wording.bodyGujarati, customerIds.slice(start, start + CHUNK), `broadcast:${broadcastId}`, link],
        )
        stored.push(...rows.map(row => String(row.customer_id)))
      }
      return stored
    },
    async listFor(customerId, { page, pageSize }) {
      const [list, counts] = await Promise.all([
        database.query<Row>(`select ${NOTIFICATION_COLUMNS} from notifications where customer_id = $1 order by created_at desc, id limit $2 offset $3`, [customerId, pageSize, (page - 1) * pageSize]),
        database.query<Row>('select count(*)::int as total, count(*) filter (where read_at is null)::int as unread from notifications where customer_id = $1', [customerId]),
      ])
      return { notifications: list.rows.map(notificationOf), total: Number(counts.rows[0]?.total ?? 0), unread: Number(counts.rows[0]?.unread ?? 0) }
    },
    async unreadCount(customerId) {
      const { rows } = await database.query<Row>('select count(*)::int as unread from notifications where customer_id = $1 and read_at is null', [customerId])
      return Number(rows[0]?.unread ?? 0)
    },
    async markRead(customerId, id) {
      const { rowCount } = await database.query('update notifications set read_at = coalesce(read_at, now()) where id = $1 and customer_id = $2', [id, customerId])
      return (rowCount ?? 0) > 0
    },
    async markAllRead(customerId) {
      const { rowCount } = await database.query('update notifications set read_at = now() where customer_id = $1 and read_at is null', [customerId])
      return rowCount ?? 0
    },

    async resolveAudience(audience) {
      const { where, params } = audienceClause(audience)
      const { rows } = await database.query<Row>(`select c.id, c.language from customers c where ${where}`, params)
      return rows.map(row => ({ customerId: String(row.id), language: row.language === 'gu' ? 'gu' : 'en' }))
    },
    async countAudience(audience) {
      const { where, params } = audienceClause(audience)
      const { rows } = await database.query<Row>(
        `select count(*)::int as customers, count(*) filter (where exists (select 1 from push_tokens t where t.customer_id = c.id and t.active))::int as with_devices from customers c where ${where}`,
        params,
      )
      return { customers: Number(rows[0]?.customers ?? 0), withDevices: Number(rows[0]?.with_devices ?? 0) }
    },
    async createBroadcast(input, adminId) {
      const { rows } = await database.query<Row>(
        `insert into broadcasts (title, title_gu, body, body_gu, audience, created_by) values ($1, $2, $3, $4, $5::jsonb, $6) returning ${BROADCAST_COLUMNS}`,
        [input.title, input.titleGujarati, input.body, input.bodyGujarati, JSON.stringify(input.audience), adminId],
      )
      return broadcastOf(rows[0] as Row)
    },
    async finishBroadcast(id, { recipients, pushed, status }) {
      await database.query('update broadcasts set recipients = $2, pushed = $3, status = $4, finished_at = now() where id = $1', [id, recipients, pushed, status])
    },
    async listBroadcasts({ page, pageSize }) {
      const { rows } = await database.query<Row>(`select ${BROADCAST_COLUMNS}, count(*) over() as total from broadcasts order by created_at desc, id limit $1 offset $2`, [pageSize, (page - 1) * pageSize])
      return { rows: rows.map(broadcastOf), total: rows[0] ? Number(rows[0].total) : 0 }
    },
  }
}
