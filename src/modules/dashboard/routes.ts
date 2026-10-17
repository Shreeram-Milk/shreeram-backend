import { Router, type Request, type Response } from 'express'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { DashboardService } from './service.js'

/** `/admin/dashboard`: one read-only roll-up for staff, never cached. */
export function createAdminDashboardRouter({ auth, dashboard, allowedOrigins }: { auth: AuthService; dashboard: DashboardService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.get('/', async (_request: Request, response: Response) => { response.json(await dashboard.get()) })
  return router
}
