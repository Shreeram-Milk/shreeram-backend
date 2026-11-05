import { Router, type Request, type RequestHandler, type Response } from 'express'
import type { z } from 'zod'
import { AppError } from '../../http/errors.js'
import { createRateLimiter } from '../../http/rate-limit.js'
import { validate } from '../../http/validate.js'
import type { SignedInAdmin } from '../auth/service.js'
import { riderCheckInBody, riderDeliveriesBody, riderLoginBody, riderSheetQuery, riderVerifyBody, type RiderCheckInBody, type RiderDeliveriesBody, type RiderSheetQuery } from './schema.js'
import type { RiderService } from './service.js'

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireRider` once the bearer token is checked. */
    rider?: SignedInAdmin
  }
}

const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined
}

/** Lets a request through only if it carries a valid rider token. A rider token is not an admin session: it opens none of the admin routes. */
function requireRider(rider: RiderService): RequestHandler {
  return async (request, _response, next) => {
    const signedIn = await rider.authenticate(bearerToken(request))
    if (!signedIn) return next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in.'))
    request.rider = signedIn
    next()
  }
}

/**
 * `/rider/*`: the rider app. It signs in with the admin password and emailed code but gets its own token, kept apart from the admin
 * panel's sessions. The app is not a browser, so there are no cookies and no Origin check. Responses are never cached.
 */
export function createRiderRouter({ rider }: { rider: RiderService }): Router {
  const router = Router()
  const signInLimiter = createRateLimiter({ windowMs: 15 * 60_000, limit: 10 })
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  const contextOf = (request: Request) => ({ ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null })
  const actorOf = (request: Request) => ({ adminId: (request.rider as SignedInAdmin).id, ip: request.ip ?? null })

  router.post('/auth/login', signInLimiter, validate('body', riderLoginBody), async (request: Request, response: Response) => {
    const body = request.body as z.infer<typeof riderLoginBody>
    await rider.startLogin(body.email, body.password, contextOf(request))
    response.status(202).json({ status: 'code_sent' })
  })
  router.post('/auth/verify', signInLimiter, validate('body', riderVerifyBody), async (request: Request, response: Response) => {
    const body = request.body as z.infer<typeof riderVerifyBody>
    const { token, expiresAt, rider: signedIn } = await rider.completeLogin(body.email, body.code, contextOf(request))
    response.json({ token, expiresAt: expiresAt.toISOString(), rider: signedIn })
  })

  router.use(requireRider(rider))

  router.get('/me', (request: Request, response: Response) => { response.json({ rider: request.rider }) })
  router.post('/auth/logout', async (request: Request, response: Response) => {
    await rider.logout(bearerToken(request))
    response.status(204).end()
  })
  router.get('/today', async (_request: Request, response: Response) => { response.json(await rider.day()) })
  router.get('/sheet', validate('query', riderSheetQuery), async (request: Request, response: Response) => {
    response.json(await rider.sheet((request.query as unknown as RiderSheetQuery).slotId))
  })
  router.post('/check-in', validate('body', riderCheckInBody), async (request: Request, response: Response) => {
    response.json(await rider.checkIn(request.body as RiderCheckInBody, actorOf(request)))
  })
  router.post('/deliveries', validate('body', riderDeliveriesBody), async (request: Request, response: Response) => {
    response.json(await rider.markOrders(request.body as RiderDeliveriesBody, actorOf(request)))
  })

  return router
}
