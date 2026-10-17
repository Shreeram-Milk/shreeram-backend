import type { Database } from '../../db/pool.js'

export type AdminUser = { id: string; email: string; passwordHash: string; status: 'active' | 'disabled'; failedLoginCount: number; lockedUntil: Date | null }
export type StoredLoginCode = { id: string; codeHash: string; attempts: number }
export type StoredSession = { sessionId: string; adminId: string; email: string }
export type NewSession = { adminId: string; tokenHash: string; expiresAt: Date; userAgent: string | null; ip: string | null }

/** Everything the sign-in service needs from storage. The Postgres version below is the real one; tests use a fake. */
export interface AuthRepository {
  findAdminByEmail(email: string): Promise<AdminUser | null>
  /** Counts a wrong password and, on reaching `lockAfter`, locks the account until `lockedUntil`. */
  recordFailedLogin(adminId: string, lockAfter: number, lockedUntil: Date): Promise<void>
  /** Clears the failure count after a full sign-in and notes the time. */
  recordSuccessfulLogin(adminId: string, now: Date): Promise<void>
  /** Cancels any unused code and stores the new one. Only one code is ever valid at a time. */
  replaceLoginCode(adminId: string, codeHash: string, expiresAt: Date): Promise<void>
  findActiveLoginCode(adminId: string, now: Date): Promise<StoredLoginCode | null>
  bumpCodeAttempts(codeId: string): Promise<void>
  /** Marks a code used. Returns false if another request already used it, so a code can never be spent twice. */
  consumeLoginCode(codeId: string, now: Date): Promise<boolean>
  createSession(session: NewSession): Promise<void>
  findSession(tokenHash: string, now: Date): Promise<StoredSession | null>
  touchSession(sessionId: string, now: Date): Promise<void>
  revokeSession(tokenHash: string, now: Date): Promise<void>
}

type Row = Record<string, unknown>
const asDate = (value: unknown): Date | null => (value instanceof Date ? value : value ? new Date(String(value)) : null)

export function createAuthRepository(database: Database): AuthRepository {
  return {
    async findAdminByEmail(email) {
      const { rows } = await database.query<Row>('select id, email, password_hash, status, failed_login_count, locked_until from admin_users where email = $1', [email])
      const row = rows[0]
      if (!row) return null
      return { id: String(row.id), email: String(row.email), passwordHash: String(row.password_hash), status: row.status === 'disabled' ? 'disabled' : 'active', failedLoginCount: Number(row.failed_login_count), lockedUntil: asDate(row.locked_until) }
    },
    async recordFailedLogin(adminId, lockAfter, lockedUntil) {
      await database.query(
        'update admin_users set failed_login_count = failed_login_count + 1, locked_until = case when failed_login_count + 1 >= $2 then $3 else locked_until end, updated_at = now() where id = $1',
        [adminId, lockAfter, lockedUntil],
      )
    },
    async recordSuccessfulLogin(adminId, now) {
      await database.query('update admin_users set failed_login_count = 0, locked_until = null, last_login_at = $2, updated_at = now() where id = $1', [adminId, now])
    },
    async replaceLoginCode(adminId, codeHash, expiresAt) {
      await database.query('update admin_login_codes set consumed_at = now() where admin_user_id = $1 and consumed_at is null', [adminId])
      await database.query('insert into admin_login_codes (admin_user_id, code_hash, expires_at) values ($1, $2, $3)', [adminId, codeHash, expiresAt])
    },
    async findActiveLoginCode(adminId, now) {
      const { rows } = await database.query<Row>('select id, code_hash, attempts from admin_login_codes where admin_user_id = $1 and consumed_at is null and expires_at > $2 order by created_at desc limit 1', [adminId, now])
      const row = rows[0]
      return row ? { id: String(row.id), codeHash: String(row.code_hash), attempts: Number(row.attempts) } : null
    },
    async bumpCodeAttempts(codeId) {
      await database.query('update admin_login_codes set attempts = attempts + 1 where id = $1', [codeId])
    },
    async consumeLoginCode(codeId, now) {
      const result = await database.query('update admin_login_codes set consumed_at = $2 where id = $1 and consumed_at is null', [codeId, now])
      return result.rowCount === 1
    },
    async createSession({ adminId, tokenHash, expiresAt, userAgent, ip }) {
      await database.query('insert into admin_sessions (admin_user_id, token_hash, expires_at, user_agent, ip_address) values ($1, $2, $3, $4, $5)', [adminId, tokenHash, expiresAt, userAgent, ip])
    },
    async findSession(tokenHash, now) {
      const { rows } = await database.query<Row>(
        `select s.id as session_id, s.admin_user_id, u.email from admin_sessions s join admin_users u on u.id = s.admin_user_id
         where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and u.status = 'active'`,
        [tokenHash, now],
      )
      const row = rows[0]
      return row ? { sessionId: String(row.session_id), adminId: String(row.admin_user_id), email: String(row.email) } : null
    },
    async touchSession(sessionId, now) {
      await database.query('update admin_sessions set last_seen_at = $2 where id = $1', [sessionId, now])
    },
    async revokeSession(tokenHash, now) {
      await database.query('update admin_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null', [tokenHash, now])
    },
  }
}
