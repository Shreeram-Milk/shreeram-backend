import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { productionPlanQuerySchema, type ProductionPlanQuery } from './schema.js'
import type { ProductionPlanService } from './service.js'

/** `/admin/production-planning?date=2026-10-15`: how much of each product to make for that day, per delivery window. */
export function createAdminProductionPlanRouter({ auth, plans, allowedOrigins }: { auth: AuthService; plans: ProductionPlanService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  router.get('/', validate('query', productionPlanQuerySchema), async (request: Request, response: Response) => {
    response.set('Cache-Control', 'no-store').json({ plan: await plans.planFor((request.query as unknown as ProductionPlanQuery).date) })
  })
  return router
}
