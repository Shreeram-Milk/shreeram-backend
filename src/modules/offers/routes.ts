import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { offerIdParamsSchema, offerInputSchema, offerStatusSchema, type OfferInput } from './schema.js'
import type { OfferService } from './service.js'

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/offers`: only a signed-in admin can list or change offers. */
export function createAdminOfferRouter({ auth, offers, allowedOrigins }: { auth: AuthService; offers: OfferService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', async (_request: Request, response: Response) => { response.json({ offers: await offers.list() }) })
  router.get('/:id', validate('params', offerIdParamsSchema), async (request: Request, response: Response) => { response.json({ offer: await offers.get(idOf(request)) }) })
  router.post('/', validate('body', offerInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ offer: await offers.create(request.body as OfferInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', offerIdParamsSchema), validate('body', offerInputSchema), async (request: Request, response: Response) => {
    response.json({ offer: await offers.update(idOf(request), request.body as OfferInput, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', offerIdParamsSchema), validate('body', offerStatusSchema), async (request: Request, response: Response) => {
    response.json({ offer: await offers.setStatus(idOf(request), (request.body as { status: 'active' | 'inactive' }).status, actorOf(request)) })
  })
  return router
}

/** `/public/offers`: the live offers the customer app lists. Nothing private, so no sign-in. */
export function createPublicOfferRouter({ offers }: { offers: OfferService }): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => { response.json({ offers: await offers.listPublic() }) })
  return router
}
