import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { createRateLimiter } from '../../http/rate-limit.js'
import { validate } from '../../http/validate.js'
import { readCookie, requireAdmin, requireTrustedOrigin, SESSION_COOKIE } from './middleware.js'
import type { AuthService, RequestContext } from './service.js'

const email = z.string().trim().toLowerCase().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email address.')
const loginBody = z.object({ email, password: z.string().min(1, 'Enter your password.').max(200) })
const verifyBody = z.object({ email, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') })

type Options = { auth: AuthService; allowedOrigins: string[]; secureCookie: boolean }

const contextOf = (request: Request): RequestContext => ({ ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null })

/** `/admin/auth/*`: sign in with a password and an emailed code, check who is signed in, sign out. */
export function createAuthRouter({ auth, allowedOrigins, secureCookie }: Options): Router {
  const router = Router()
  // Far stricter than the general limit: 10 attempts per 15 minutes per address, on top of the per-account lockout.
  const signInLimiter = createRateLimiter({ windowMs: 15 * 60_000, limit: 10 })

  router.use(requireTrustedOrigin(allowedOrigins))

  router.post('/login', signInLimiter, validate('body', loginBody), async (request: Request, response: Response) => {
    const body = request.body as z.infer<typeof loginBody>
    await auth.startLogin(body.email, body.password, contextOf(request))
    response.status(202).json({ status: 'code_sent' })
  })

  router.post('/verify', signInLimiter, validate('body', verifyBody), async (request: Request, response: Response) => {
    const body = request.body as z.infer<typeof verifyBody>
    const { token, expiresAt, admin } = await auth.completeLogin(body.email, body.code, contextOf(request))
    // HttpOnly: scripts on the page cannot read it. SameSite=Lax plus the origin check stops cross-site use.
    response.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/', expires: expiresAt })
    response.json({ admin })
  })

  router.get('/me', requireAdmin(auth), (request: Request, response: Response) => { response.json({ admin: request.admin }) })

  router.post('/logout', async (request: Request, response: Response) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    await auth.logout(token, await auth.authenticate(token), contextOf(request))
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/' })
    response.status(204).end()
  })

  return router
}
