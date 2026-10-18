import type { Database } from '../../db/pool.js'

export type CustomerStatus = 'active' | 'blocked' | 'deleted'
export type Customer = { id: string; phone: string | null; name: string; email: string; language: 'en' | 'gu'; customerType: 'prepaid' | 'credit'; status: CustomerStatus }
export type StoredCode = { id: string; codeHash: string; attempts: number }
export type NewCode = { email: string; codeHash: string; channel: 'console' | 'email'; expiresAt: Date; ip: string }
export type NewCustomerSession = { customerId: string; tokenHash: string; deviceLabel: string; expiresAt: Date }
/** A customer changes their name, contact number and language. Their email is how they sign in, so it is not part of this. */
export type ProfileUpdate = { name: string; phone: string | null; language: 'en' | 'gu' }

/** Everything customer sign-in needs from storage. The Postgres version below is the real one; tests use a fake. */
export interface CustomerAuthRepository {
  /** How many codes this email / address asked for since `since`, and when the latest one was made. */
  countCodes(filter: { email?: string; ip?: string; since: Date }): Promise<{ count: number; latestAt: Date | null }>
  /** Cancels any unused code for the email and stores the new one. Only one code is valid at a time. */
  replaceCode(code: NewCode): Promise<void>
  findActiveCode(email: string, now: Date): Promise<StoredCode | null>
  bumpCodeAttempts(codeId: string): Promise<void>
  /** Returns false if another request already used the code, so a code can never be spent twice. */
  consumeCode(codeId: string, now: Date): Promise<boolean>
  findByEmail(email: string): Promise<Customer | null>
  /** Finds the customer with this email or creates one. Safe when two requests race. */
  findOrCreateByEmail(email: string): Promise<{ customer: Customer; created: boolean }>
  findById(id: string): Promise<Customer | null>
  recordSignIn(customerId: string, now: Date): Promise<void>
  createSession(session: NewCustomerSession): Promise<void>
  /** The customer for a live session, or null when expired, revoked, blocked or deleted. */
  findSession(tokenHash: string, now: Date): Promise<{ sessionId: string; customer: Customer } | null>
  touchSession(sessionId: string, now: Date): Promise<void>
  revokeSession(tokenHash: string, now: Date): Promise<void>
  updateProfile(customerId: string, update: ProfileUpdate): Promise<Customer | null>
  /** Account deletion: blanks personal details, switches to deleted and signs out every phone. Orders and payments stay. */
  anonymise(customerId: string, now: Date): Promise<void>
}

type Row = Record<string, unknown>
const COLUMNS = 'id, phone, name, email, language, customer_type, status'
const toCustomer = (row: Row): Customer => ({
  id: String(row.id),
  phone: row.phone === null ? null : String(row.phone),
  name: String(row.name),
  email: String(row.email),
  language: row.language === 'gu' ? 'gu' : 'en',
  customerType: row.customer_type === 'credit' ? 'credit' : 'prepaid',
  status: row.status === 'blocked' ? 'blocked' : row.status === 'deleted' ? 'deleted' : 'active',
})

export function createCustomerAuthRepository(database: Database): CustomerAuthRepository {
  return {
    async countCodes({ email, ip, since }) {
      const { rows } = await database.query<Row>(
        'select count(*)::int as count, max(created_at) as latest from customer_sign_in_codes where created_at > $1 and ($2::text is null or email = $2) and ($3::text is null or request_ip = $3)',
        [since, email ?? null, ip ?? null],
      )
      const row = rows[0] ?? {}
      return { count: Number(row.count ?? 0), latestAt: row.latest ? new Date(String(row.latest)) : null }
    },
    async replaceCode({ email, codeHash, channel, expiresAt, ip }) {
      await database.query('update customer_sign_in_codes set consumed_at = now() where email = $1 and consumed_at is null', [email])
      await database.query('insert into customer_sign_in_codes (email, code_hash, channel, expires_at, request_ip) values ($1, $2, $3, $4, $5)', [email, codeHash, channel, expiresAt, ip])
    },
    async findActiveCode(email, now) {
      const { rows } = await database.query<Row>('select id, code_hash, attempts from customer_sign_in_codes where email = $1 and consumed_at is null and expires_at > $2 order by created_at desc limit 1', [email, now])
      const row = rows[0]
      return row ? { id: String(row.id), codeHash: String(row.code_hash), attempts: Number(row.attempts) } : null
    },
    async bumpCodeAttempts(codeId) {
      await database.query('update customer_sign_in_codes set attempts = attempts + 1 where id = $1', [codeId])
    },
    async consumeCode(codeId, now) {
      const result = await database.query('update customer_sign_in_codes set consumed_at = $2 where id = $1 and consumed_at is null', [codeId, now])
      return (result.rowCount ?? 0) === 1
    },
    async findByEmail(email) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from customers where lower(email) = $1 and status <> 'deleted'`, [email])
      return rows[0] ? toCustomer(rows[0]) : null
    },
    async findOrCreateByEmail(email) {
      const inserted = await database.query<Row>(`insert into customers (email) values ($1) on conflict (lower(email)) where email <> '' and status <> 'deleted' do nothing returning ${COLUMNS}`, [email])
      if (inserted.rows[0]) return { customer: toCustomer(inserted.rows[0]), created: true }
      const { rows } = await database.query<Row>(`select ${COLUMNS} from customers where lower(email) = $1 and status <> 'deleted'`, [email])
      if (!rows[0]) throw new Error('Customer could not be created.')
      return { customer: toCustomer(rows[0]), created: false }
    },
    async findById(id) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from customers where id = $1`, [id])
      return rows[0] ? toCustomer(rows[0]) : null
    },
    async recordSignIn(customerId, now) {
      await database.query('update customers set last_sign_in_at = $2, updated_at = now() where id = $1', [customerId, now])
    },
    async createSession({ customerId, tokenHash, deviceLabel, expiresAt }) {
      await database.query('insert into customer_sessions (customer_id, token_hash, device_label, expires_at) values ($1, $2, $3, $4)', [customerId, tokenHash, deviceLabel, expiresAt])
    },
    async findSession(tokenHash, now) {
      const { rows } = await database.query<Row>(
        "select s.id as session_id, c.id, c.phone, c.name, c.email, c.language, c.customer_type, c.status from customer_sessions s join customers c on c.id = s.customer_id where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and c.status = 'active'",
        [tokenHash, now],
      )
      const row = rows[0]
      return row ? { sessionId: String(row.session_id), customer: toCustomer(row) } : null
    },
    async touchSession(sessionId, now) {
      await database.query('update customer_sessions set last_used_at = $2 where id = $1', [sessionId, now])
    },
    async revokeSession(tokenHash, now) {
      await database.query('update customer_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null', [tokenHash, now])
    },
    async updateProfile(customerId, { name, phone, language }) {
      const { rows } = await database.query<Row>(`update customers set name = $2, phone = $3, language = $4, updated_at = now() where id = $1 and status = 'active' returning ${COLUMNS}`, [customerId, name, phone, language])
      return rows[0] ? toCustomer(rows[0]) : null
    },
    async anonymise(customerId, now) {
      await database.query(
        // One statement, so a deletion can never leave addresses or delivery notes behind. The address rows stay (marked removed) with
        // placeholder text, because the columns must hold something and old orders still point at them. Push tokens are deleted so
        // no phone is ever notified for a deleted account.
        `with signed_out as (update customer_sessions set revoked_at = $2 where customer_id = $1 and revoked_at is null returning 1),
              push_removed as (delete from push_tokens where customer_id = $1 returning 1),
              addresses_blanked as (update customer_addresses set recipient_name = 'Removed', recipient_phone = '+910000000000', line1 = 'Removed', line2 = '', landmark = '', city = '', is_default = false, removed_at = coalesce(removed_at, $2), updated_at = now() where customer_id = $1 returning 1),
              notes_blanked as (update customer_doorstep_instructions set additional_instructions = '', updated_at = now() where customer_id = $1 returning 1),
              tickets_blanked as (update support_ticket_messages set body = '[removed]' where author = 'customer' and ticket_id in (select id from support_tickets where customer_id = $1) returning 1)
         update customers set status = 'deleted', phone = null, name = '', email = '', google_subject = null, admin_note = '', deleted_at = $2, updated_at = now() where id = $1`,
        [customerId, now],
      )
    },
  }
}
