import type { Database } from '../../db/pool.js'

export type AuditEntry = {
  adminId: string | null
  /** Short snake_case name of what happened, such as `login_succeeded` or `banner_updated`. */
  action: string
  /** Safe facts only: ids and field names. Never passwords, codes, tokens or personal details. */
  details?: Record<string, unknown>
  ip?: string | null
}

export type AuditWriter = (entry: AuditEntry) => Promise<void>

/** Records who did what, and when, in `admin_audit_log`. */
export function createAuditWriter(database: Database): AuditWriter {
  return async ({ adminId, action, details = {}, ip = null }) => {
    await database.query('insert into admin_audit_log (admin_user_id, action, details, ip_address) values ($1, $2, $3::jsonb, $4)', [adminId, action, JSON.stringify(details), ip])
  }
}
