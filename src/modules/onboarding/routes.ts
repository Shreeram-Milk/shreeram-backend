import { Router, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { slideIdParamsSchema, slideInputSchema, slideMoveSchema, slideStatusSchema, type SlideInput, type SlideStatus } from './schema.js'
import type { OnboardingService } from './service.js'

type Options = { auth: AuthService; onboarding: OnboardingService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/onboarding`: only a signed-in admin can read or change the introduction slides. */
export function createAdminOnboardingRouter({ auth, onboarding, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', async (_request: Request, response: Response) => { response.json({ slides: await onboarding.list() }) })
  router.get('/:id', validate('params', slideIdParamsSchema), async (request: Request, response: Response) => { response.json({ slide: await onboarding.get(idOf(request)) }) })
  router.post('/', validate('body', slideInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ slide: await onboarding.create(request.body as SlideInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', slideIdParamsSchema), validate('body', slideInputSchema), async (request: Request, response: Response) => {
    response.json({ slide: await onboarding.update(idOf(request), request.body as SlideInput, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', slideIdParamsSchema), validate('body', slideStatusSchema), async (request: Request, response: Response) => {
    response.json({ slide: await onboarding.setStatus(idOf(request), (request.body as { status: SlideStatus }).status, actorOf(request)) })
  })
  router.post('/:id/move', validate('params', slideIdParamsSchema), validate('body', slideMoveSchema), async (request: Request, response: Response) => {
    response.json({ slides: await onboarding.move(idOf(request), (request.body as { direction: 'up' | 'down' }).direction, actorOf(request)) })
  })
  return router
}

/** `/public/onboarding`: what the customer app shows on first launch. No sign-in; it holds nothing private. */
export function createPublicOnboardingRouter({ onboarding }: Pick<Options, 'onboarding'>): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => { sendPublic(response, { slides: await onboarding.listPublic() }) })
  return router
}
