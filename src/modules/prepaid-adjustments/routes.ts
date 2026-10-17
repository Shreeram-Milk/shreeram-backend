import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { adjustmentIdParamsSchema, adjustmentListQuerySchema, applyAdjustmentSchema, newAdjustmentSchema, type AdjustmentListQuery, type ApplyAdjustment, type NewAdjustment } from './schema.js'
import type { AdjustmentService } from './service.js'

/** `/admin/prepaid-adjustments`: what the business owes prepaid customers (refunds to send, credit, carried-forward deliveries), and marking each done. */
export function createAdminAdjustmentRouter({ auth, adjustments, allowedOrigins }: { auth: AuthService; adjustments: AdjustmentService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
  const idOf = (request: Request) => (request.params as { id: string }).id

  router.get('/', validate('query', adjustmentListQuerySchema), async (request: Request, response: Response) => { response.json(await adjustments.list(request.query as unknown as AdjustmentListQuery)) })
  router.post('/', validate('body', newAdjustmentSchema), async (request: Request, response: Response) => {
    response.status(201).json({ adjustment: await adjustments.create(request.body as NewAdjustment, actorOf(request)) })
  })
  router.post('/:id/apply', validate('params', adjustmentIdParamsSchema), validate('body', applyAdjustmentSchema), async (request: Request, response: Response) => {
    response.json({ adjustment: await adjustments.apply(idOf(request), request.body as ApplyAdjustment, actorOf(request)) })
  })
  router.post('/:id/cancel', validate('params', adjustmentIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ adjustment: await adjustments.cancel(idOf(request), actorOf(request)) })
  })
  return router
}
