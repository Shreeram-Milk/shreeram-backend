import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { pageQuerySchema, recordIdParamsSchema, statusChangeSchema, type PageQuery, type StatusChange } from '../master-data/shared.js'
import { deliverySlotInputSchema, type DeliverySlotInput } from './schema.js'
import type { DeliverySlotService } from './service.js'

type Options = { auth: AuthService; slots: DeliverySlotService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/delivery-slots`: only a signed-in admin can read or change delivery slots. */
export function createAdminDeliverySlotRouter({ auth, slots, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', validate('query', pageQuerySchema), async (request: Request, response: Response) => { response.json(await slots.list(request.query as unknown as PageQuery)) })
  router.get('/all', async (_request: Request, response: Response) => { response.json({ rows: await slots.listAll() }) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ slot: await slots.get(idOf(request)) }) })
  router.get('/:id/usage', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ usage: await slots.usage(idOf(request)) }) })
  router.post('/', validate('body', deliverySlotInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ slot: await slots.create(request.body as DeliverySlotInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', recordIdParamsSchema), validate('body', deliverySlotInputSchema), async (request: Request, response: Response) => {
    response.json({ slot: await slots.update(idOf(request), request.body as DeliverySlotInput, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', recordIdParamsSchema), validate('body', statusChangeSchema), async (request: Request, response: Response) => {
    response.json({ slot: await slots.setStatus(idOf(request), request.body as StatusChange, actorOf(request)) })
  })
  router.delete('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => {
    await slots.remove(idOf(request), actorOf(request))
    response.status(204).end()
  })
  return router
}
