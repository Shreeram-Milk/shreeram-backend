import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { customerListQuerySchema, customerUpdateSchema, recordIdParamsSchema, type CustomerListQuery, type CustomerUpdate } from './schema.js'
import type { CustomerService } from './service.js'

type Options = { auth: AuthService; customers: CustomerService; allowedOrigins: string[] }

const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/customers`: only a signed-in admin can see or change customers. Responses are never cached. */
export function createAdminCustomerRouter({ auth, customers, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.get('/', validate('query', customerListQuerySchema), async (request: Request, response: Response) => { response.json(await customers.list(request.query as unknown as CustomerListQuery)) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ customer: await customers.get(idOf(request)) }) })
  router.get('/:id/addresses', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json(await customers.getAddresses(idOf(request))) })
  router.put('/:id', validate('params', recordIdParamsSchema), validate('body', customerUpdateSchema), async (request: Request, response: Response) => {
    response.json({ customer: await customers.update(idOf(request), request.body as CustomerUpdate, { adminId: (request.admin as { id: string }).id, ip: request.ip ?? null }) })
  })
  return router
}
