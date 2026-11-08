import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import type { RewardService } from './service.js'

const cardParamsSchema = z.object({ id: z.uuid('That is not a valid scratch card id.') })
const customerIdOf = (request: Request) => (request.customer as Customer).id
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/customer/rewards`: a signed-in customer's own scratch cards. Never cached. */
export function createCustomerRewardRouter({ auth, rewards }: { auth: CustomerAuthService; rewards: RewardService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.get('/', async (request: Request, response: Response) => { response.json({ cards: await rewards.listMine(customerIdOf(request)) }) })
  router.get('/:id', validate('params', cardParamsSchema), async (request: Request, response: Response) => { response.json({ card: await rewards.getMine(customerIdOf(request), idOf(request)) }) })
  router.post('/:id/scratch', validate('params', cardParamsSchema), async (request: Request, response: Response) => { response.json({ card: await rewards.scratch(customerIdOf(request), idOf(request)) }) })
  return router
}

/** `/admin/rewards`: how many cards were given, scratched and used. */
export function createAdminRewardRouter({ auth, rewards, allowedOrigins }: { auth: AuthService; rewards: RewardService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  router.get('/stats', async (_request: Request, response: Response) => { response.json({ stats: await rewards.stats() }) })
  return router
}
