import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import { decoyHash, hashCode, newCode, newToken, safeEqual, sha256, verifyPassword } from './crypto.js'
import type { AuthRepository } from './repository.js'

/** Delivers the one-time login code. Development prints it; production emails it. */
export interface CodeSender {
  sendLoginCode(email: string, code: string): Promise<void>
}

export type RequestContext = { ip: string | null; userAgent: string | null }
export type SignedInAdmin = { id: string; email: string }

export const LOCK_AFTER_FAILURES = 5
export const LOCK_MINUTES = 15
export const CODE_MINUTES = 10
export const CODE_MAX_ATTEMPTS = 5
export const SESSION_DAYS = 7

const minutes = (count: number) => count * 60_000
const days = (count: number) => count * 24 * 60 * 60_000

type Dependencies = { repository: AuthRepository; sender: CodeSender; audit: AuditWriter; secret: string; now?: () => Date }

/**
 * Admin sign-in in two steps. Step 1 checks the password and emails a one-time code. Step 2 checks the code and
 * opens a session. Wrong answers always look the same to the caller, so the form cannot be used to find out
 * which emails belong to an admin.
 */
export function createAuthService({ repository, sender, audit, secret, now = () => new Date() }: Dependencies) {
  const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is not correct.')
  const invalidCode = () => new AppError(401, 'INVALID_CODE', 'The code is not correct or has expired.')

  return {
    /** Step 1: check the password, then send a code. Returns nothing; the code arrives out of band. */
    async startLogin(email: string, password: string, context: RequestContext): Promise<void> {
      const admin = await repository.findAdminByEmail(email)
      if (!admin || admin.status !== 'active') {
        await verifyPassword(password, await decoyHash())
        await audit({ adminId: null, action: 'login_failed', details: { reason: 'unknown_or_disabled' }, ip: context.ip })
        throw invalidCredentials()
      }
      if (admin.lockedUntil && admin.lockedUntil > now()) {
        await audit({ adminId: admin.id, action: 'login_blocked', details: { reason: 'locked' }, ip: context.ip })
        throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many wrong attempts. Please try again later.')
      }
      if (!(await verifyPassword(password, admin.passwordHash))) {
        await repository.recordFailedLogin(admin.id, LOCK_AFTER_FAILURES, new Date(now().getTime() + minutes(LOCK_MINUTES)))
        await audit({ adminId: admin.id, action: 'login_failed', details: { reason: 'wrong_password' }, ip: context.ip })
        throw invalidCredentials()
      }
      const code = newCode()
      await repository.replaceLoginCode(admin.id, hashCode(secret, admin.id, code), new Date(now().getTime() + minutes(CODE_MINUTES)))
      try {
        await sender.sendLoginCode(admin.email, code)
      } catch (error) {
        // The reason (a wrong mail password, a network problem) stays in the server log; the admin sees a plain message.
        console.error(`Could not send the login code: ${error instanceof Error ? error.message : String(error)}`)
        await audit({ adminId: admin.id, action: 'login_code_failed', ip: context.ip })
        throw new AppError(503, 'EMAIL_FAILED', 'The login code could not be sent. Please try again.')
      }
      await audit({ adminId: admin.id, action: 'login_code_sent', ip: context.ip })
    },

    /** Step 2: check the code and open a session. The returned token goes in a cookie; only its hash is stored. */
    async completeLogin(email: string, code: string, context: RequestContext): Promise<{ token: string; expiresAt: Date; admin: SignedInAdmin }> {
      const admin = await repository.findAdminByEmail(email)
      const stored = admin && admin.status === 'active' ? await repository.findActiveLoginCode(admin.id, now()) : null
      if (!admin || !stored || stored.attempts >= CODE_MAX_ATTEMPTS) throw invalidCode()
      if (!safeEqual(hashCode(secret, admin.id, code), stored.codeHash)) {
        await repository.bumpCodeAttempts(stored.id)
        await audit({ adminId: admin.id, action: 'login_code_wrong', ip: context.ip })
        throw invalidCode()
      }
      // Spending the code is atomic: if two requests race with the same correct code, only one gets a session.
      if (!(await repository.consumeLoginCode(stored.id, now()))) throw invalidCode()
      await repository.recordSuccessfulLogin(admin.id, now())
      const token = newToken()
      const expiresAt = new Date(now().getTime() + days(SESSION_DAYS))
      await repository.createSession({ adminId: admin.id, tokenHash: sha256(token), expiresAt, userAgent: context.userAgent?.slice(0, 300) ?? null, ip: context.ip })
      await audit({ adminId: admin.id, action: 'login_succeeded', ip: context.ip })
      return { token, expiresAt, admin: { id: admin.id, email: admin.email } }
    },

    /** Who is signed in for this cookie, or null if it is missing, expired, revoked, or the admin was disabled. */
    async authenticate(token: string | undefined): Promise<SignedInAdmin | null> {
      if (!token) return null
      const session = await repository.findSession(sha256(token), now())
      if (!session) return null
      await repository.touchSession(session.sessionId, now())
      return { id: session.adminId, email: session.email }
    },

    async logout(token: string | undefined, admin: SignedInAdmin | null, context: RequestContext): Promise<void> {
      if (!token) return
      await repository.revokeSession(sha256(token), now())
      if (admin) await audit({ adminId: admin.id, action: 'logout', ip: context.ip })
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
