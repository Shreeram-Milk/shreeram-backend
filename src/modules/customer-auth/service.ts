import { AppError } from '../../http/errors.js'
import { hashCode, newCode, newToken, safeEqual, sha256 } from '../auth/crypto.js'
import type { GoogleIdTokenVerifier } from '../../integrations/google/id-token.js'
import type { Customer, CustomerAuthRepository, NewCode, SignInMethod } from './repository.js'

/** Delivers the one-time sign-in code to a customer's email. Development prints it; production sends it by email (SMTP). */
export interface CustomerCodeSender {
  readonly channel: NewCode['channel']
  sendCode(email: string, code: string): Promise<void>
}

export const CODE_MINUTES = 10
export const CODE_MAX_ATTEMPTS = 5
export const RESEND_SECONDS = 60
export const MAX_CODES_PER_EMAIL_PER_HOUR = 50
export const MAX_CODES_PER_IP_PER_HOUR = 100
/** Phones stay signed in for a long time; signing out or deleting the account ends it at once. */
export const SESSION_DAYS = 90

const minutes = (count: number) => count * 60_000
const days = (count: number) => count * 24 * 60 * 60_000

/** What the app is told about a customer. Never the status, admin note or internal fields. */
export type CustomerProfile = { id: string; email: string; phone: string; name: string; language: 'en' | 'gu'; needsProfile: boolean }
export const toProfile = (customer: Customer): CustomerProfile => ({ id: customer.id, phone: customer.phone ?? '', name: customer.name, email: customer.email, language: customer.language, needsProfile: customer.name.trim() === '' })

type Dependencies = {
  repository: CustomerAuthRepository; sender: CustomerCodeSender; secret: string; now?: () => Date
  /** A fixed demo sign-in for the store reviewer (see the REVIEW_ACCOUNT settings). Its code is not emailed; the same limits and expiry apply. */
  reviewAccount?: { email: string; code: string }
  /** Checks a Google ID token. Left out, "Continue with Google" is not available and says so. */
  googleVerifier?: GoogleIdTokenVerifier
}

/**
 * Customer sign-in with a code sent to their email. Step 1 sends a code. Step 2 checks it and opens a session; the customer
 * record is created only then, so asking for codes never fills the customer list. Wrong answers look the same whatever the reason.
 */
export function createCustomerAuthService({ repository, sender, secret, reviewAccount, googleVerifier, now = () => new Date() }: Dependencies) {
  const invalidCode = () => new AppError(401, 'INVALID_CODE', 'The code is not correct or has expired.')
  const blocked = () => new AppError(403, 'ACCOUNT_BLOCKED', 'This account cannot sign in. Please contact support.')

  type SignedIn = { token: string; expiresAt: Date; customer: CustomerProfile; isNewCustomer: boolean }

  /** The last step of every sign-in: a blocked customer is refused, otherwise a long-lived session is opened for this phone. */
  async function openSession(customer: Customer, created: boolean, method: SignInMethod, deviceLabel: string): Promise<SignedIn> {
    if (customer.status !== 'active') throw blocked()
    await repository.recordSignIn(customer.id, now())
    const token = newToken()
    const expiresAt = new Date(now().getTime() + days(SESSION_DAYS))
    await repository.createSession({ customerId: customer.id, tokenHash: sha256(token), deviceLabel: deviceLabel.slice(0, 100), expiresAt, method })
    return { token, expiresAt, customer: toProfile(customer), isNewCustomer: created }
  }

  return {
    async requestCode(email: string, ip: string): Promise<void> {
      const existing = await repository.findByEmail(email)
      if (existing && existing.status === 'blocked') throw blocked()
      const hourAgo = new Date(now().getTime() - minutes(60))
      const forEmail = await repository.countCodes({ email, since: hourAgo })
      if (forEmail.latestAt && now().getTime() - forEmail.latestAt.getTime() < RESEND_SECONDS * 1000) throw new AppError(429, 'CODE_TOO_SOON', 'Please wait a minute before asking for another code.')
      if (forEmail.count >= MAX_CODES_PER_EMAIL_PER_HOUR) throw new AppError(429, 'TOO_MANY_CODES', 'Too many codes were requested. Please try again in an hour.')
      if (ip && (await repository.countCodes({ ip, since: hourAgo })).count >= MAX_CODES_PER_IP_PER_HOUR) throw new AppError(429, 'TOO_MANY_CODES', 'Too many codes were requested. Please try again in an hour.')

      const forReviewer = reviewAccount !== undefined && email === reviewAccount.email
      const code = forReviewer ? reviewAccount.code : newCode()
      await repository.replaceCode({ email, codeHash: hashCode(secret, email, code), channel: sender.channel, expiresAt: new Date(now().getTime() + minutes(CODE_MINUTES)), ip })
      if (forReviewer) return
      try {
        await sender.sendCode(email, code)
      } catch (error) {
        // The reason (a wrong provider key, a network problem) stays in the server log; the customer sees a plain message.
        console.error(`Could not send the sign-in code: ${error instanceof Error ? error.message : String(error)}`)
        throw new AppError(503, 'CODE_SEND_FAILED', 'The code could not be sent. Please try again.')
      }
    },

    async verifyCode(email: string, code: string, deviceLabel: string): Promise<SignedIn> {
      const stored = await repository.findActiveCode(email, now())
      if (!stored || stored.attempts >= CODE_MAX_ATTEMPTS) throw invalidCode()
      if (!safeEqual(hashCode(secret, email, code), stored.codeHash)) {
        await repository.bumpCodeAttempts(stored.id)
        throw invalidCode()
      }
      // Spending the code is atomic: if two requests race with the same correct code, only one gets a session.
      if (!(await repository.consumeCode(stored.id, now()))) throw invalidCode()
      const { customer, created } = await repository.findOrCreateByEmail(email)
      return openSession(customer, created, 'email_code', deviceLabel)
    },

    /**
     * "Continue with Google". The phone sends the ID token Google gave it; we check it (signature, expiry, our own app id) and require a
     * verified email. The same person is found by Google's permanent id; a customer who first signed in with an emailed code and uses the
     * same Gmail is linked to that same account, never duplicated.
     */
    async signInWithGoogle(idToken: string, deviceLabel: string): Promise<SignedIn> {
      if (!googleVerifier) throw new AppError(503, 'GOOGLE_SIGN_IN_UNAVAILABLE', 'Google sign-in is not available right now. Please use your email.')
      const identity = await googleVerifier(idToken)
      if (!identity.emailVerified) throw new AppError(403, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Your Google email is not verified. Please use another way to sign in.')
      let created = false
      let customer = await repository.findByGoogleSubject(identity.subject)
      if (!customer) {
        const byEmail = await repository.findByEmail(identity.email)
        if (byEmail) {
          // The same person by email. If that account already belongs to another Google account, never merge them.
          if (!(await repository.linkGoogle(byEmail.id, identity.subject))) throw new AppError(409, 'GOOGLE_ACCOUNT_CONFLICT', 'This email is already linked to a different Google account. Please sign in with your email code.')
          customer = byEmail
        } else {
          customer = await repository.createWithGoogle({ email: identity.email, name: identity.name, subject: identity.subject })
          created = customer !== null
          // Two taps at the same moment: the other request made the account first, so use it.
          customer ??= await repository.findByGoogleSubject(identity.subject)
          if (!customer) throw new Error('Customer could not be created.')
        }
      }
      return openSession(customer, created, 'google', deviceLabel)
    },

    /** Who is signed in for this token, or null if it is missing, expired, revoked, or the customer was blocked or deleted. */
    async authenticate(token: string | undefined): Promise<Customer | null> {
      if (!token) return null
      const session = await repository.findSession(sha256(token), now())
      if (!session) return null
      await repository.touchSession(session.sessionId, now())
      return session.customer
    },

    async signOut(token: string | undefined): Promise<void> {
      if (token) await repository.revokeSession(sha256(token), now())
    },

    async updateProfile(customerId: string, update: { name: string; phone: string | null; language: 'en' | 'gu' }): Promise<CustomerProfile> {
      const customer = await repository.updateProfile(customerId, update)
      if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found.')
      return toProfile(customer)
    },

    async deleteAccount(customerId: string): Promise<void> {
      await repository.anonymise(customerId, now())
    },
  }
}

export type CustomerAuthService = ReturnType<typeof createCustomerAuthService>
