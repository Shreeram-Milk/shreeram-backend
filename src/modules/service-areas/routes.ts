import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { pageQuerySchema, recordIdParamsSchema, statusChangeSchema, type PageQuery, type StatusChange } from '../master-data/shared.js'
import { bulkPinInputSchema, pinInputSchema, pinListQuerySchema, pinParamsSchema, serviceAreaInputSchema, type BulkPinInput, type PinInput, type PinListQuery, type ServiceAreaInput } from './schema.js'
import type { ServiceAreaService } from './service.js'

type Options = { auth: AuthService; areas: ServiceAreaService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id
const pinIdOf = (request: Request) => (request.params as { pinId: string }).pinId

/** `/admin/service-areas`: only a signed-in admin can read or change service areas and their PIN codes. */
export function createAdminServiceAreaRouter({ auth, areas, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', validate('query', pageQuerySchema), async (request: Request, response: Response) => { response.json(await areas.list(request.query as unknown as PageQuery)) })
  router.get('/all', async (_request: Request, response: Response) => { response.json({ rows: await areas.listAll() }) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ area: await areas.get(idOf(request)) }) })
  router.get('/:id/usage', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ usage: await areas.usage(idOf(request)) }) })
  router.post('/', validate('body', serviceAreaInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ area: await areas.create(request.body as ServiceAreaInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', recordIdParamsSchema), validate('body', serviceAreaInputSchema), async (request: Request, response: Response) => {
    response.json({ area: await areas.update(idOf(request), request.body as ServiceAreaInput, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', recordIdParamsSchema), validate('body', statusChangeSchema), async (request: Request, response: Response) => {
    response.json({ area: await areas.setStatus(idOf(request), request.body as StatusChange, actorOf(request)) })
  })

  router.get('/:id/pins', validate('params', recordIdParamsSchema), validate('query', pinListQuerySchema), async (request: Request, response: Response) => {
    response.json(await areas.listPins(idOf(request), request.query as unknown as PinListQuery))
  })
  // "bulk" is registered before "/:pinId" so it is never read as a PIN id.
  router.post('/:id/pins/bulk', validate('params', recordIdParamsSchema), validate('body', bulkPinInputSchema), async (request: Request, response: Response) => {
    response.status(201).json(await areas.addPins(idOf(request), request.body as BulkPinInput, actorOf(request)))
  })
  router.get('/:id/pins/:pinId', validate('params', pinParamsSchema), async (request: Request, response: Response) => { response.json({ pin: await areas.getPin(idOf(request), pinIdOf(request)) }) })
  router.post('/:id/pins', validate('params', recordIdParamsSchema), validate('body', pinInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ pin: await areas.createPin(idOf(request), request.body as PinInput, actorOf(request)) })
  })
  router.put('/:id/pins/:pinId', validate('params', pinParamsSchema), validate('body', pinInputSchema), async (request: Request, response: Response) => {
    response.json({ pin: await areas.updatePin(idOf(request), pinIdOf(request), request.body as PinInput, actorOf(request)) })
  })
  router.delete('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => {
    await areas.remove(idOf(request), actorOf(request))
    response.status(204).end()
  })
  return router
}
