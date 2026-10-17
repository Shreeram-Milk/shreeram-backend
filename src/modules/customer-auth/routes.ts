import { Router, type Request, type RequestHandler, type Response } from 'express'
import type { z } from 'zod'
import { AppError } from '../../http/errors.js'
import { createRateLimiter } from '../../http/rate-limit.js'
import { validate } from '../../http/validate.js'
import { requestCodeBody, updateProfileBody, verifyCodeBody } from './schema.js'
import { toProfile, type CustomerAuthService } from './service.js'
import type { Customer } from './repository.js'

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireCustomer` once the bearer token is checked. */
    customer?: Customer
  }
}

const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined
}

/** Lets a request through only if it carries a valid customer token. Other customer features reuse this. */
export function requireCustomer(auth: CustomerAuthService): RequestHandler {
  return async (request, _response, next) => {
    const customer = await auth.authenticate(bearerToken(request))
    if (!customer) return next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in.'))
    request.customer = customer
    next()
  }
}

/**
 * `/customer/auth/*` and `/customer/me`: the phone app signs in with a code sent to the customer's email and keeps a bearer token.
 * Responses are never cached. The app is not a browser, so there are no cookies and no Origin check.
 */
export function createCustomerAuthRouter({ auth }: { auth: CustomerAuthService }): Router {
  const router = Router()
  // On top of the per-email and per-address limits in the service: slow down guessing from one address.
  const codeLimiter = createRateLimiter({ windowMs: 15 * 60_000, limit: 20 })
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.post('/auth/request-code', codeLimiter, validate('body', requestCodeBody), async (request: Request, response: Response) => {
    const body = request.body as z.infer<typeof requestCodeBody>
    await auth.requestCode(body.email, request.ip ?? '')
    response.status(202).json({ status: 'code_sent', resendAfterSeconds: 60 })
  })

  router.post('/auth/verify', codeLimiter, validate('body', verifyCodeBody), async (request: Request, response: Response) => {
    const body = request.body as z.infer<typeof verifyCodeBody>
    const { token, expiresAt, customer, isNewCustomer } = await auth.verifyCode(body.email, body.code, body.deviceLabel)
    response.json({ token, expiresAt: expiresAt.toISOString(), customer, isNewCustomer })
  })

  router.post('/auth/logout', async (request: Request, response: Response) => {
    await auth.signOut(bearerToken(request))
    response.status(204).end()
  })

  router.get('/me', requireCustomer(auth), (request: Request, response: Response) => {
    response.json({ customer: toProfile(request.customer as Customer) })
  })

  router.put('/me', requireCustomer(auth), validate('body', updateProfileBody), async (request: Request, response: Response) => {
    const body = request.body as z.infer<typeof updateProfileBody>
    response.json({ customer: await auth.updateProfile((request.customer as Customer).id, body) })
  })

  router.delete('/me', requireCustomer(auth), async (request: Request, response: Response) => {
    await auth.deleteAccount((request.customer as Customer).id)
    response.status(204).end()
  })

  return router
}
