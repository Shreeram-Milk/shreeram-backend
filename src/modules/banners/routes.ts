import { Router, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { bannerInputSchema, bannerStatusSchema, idParamsSchema, type BannerInput } from './schema.js'
import type { BannerService } from './service.js'

type Options = { auth: AuthService; banners: BannerService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/banners`: only a signed-in admin can list or change banners. */
export function createAdminBannerRouter({ auth, banners, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', async (_request: Request, response: Response) => { response.json({ banners: await banners.list() }) })
  router.get('/:id', validate('params', idParamsSchema), async (request: Request, response: Response) => { response.json({ banner: await banners.get(idOf(request)) }) })
  router.post('/', validate('body', bannerInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ banner: await banners.create(request.body as BannerInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', idParamsSchema), validate('body', bannerInputSchema), async (request: Request, response: Response) => {
    response.json({ banner: await banners.update(idOf(request), request.body as BannerInput, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', idParamsSchema), validate('body', bannerStatusSchema), async (request: Request, response: Response) => {
    response.json({ banner: await banners.setStatus(idOf(request), (request.body as { status: 'active' | 'inactive' }).status, actorOf(request)) })
  })
  return router
}

/** `/public/banners`: what the customer app shows. No sign-in; it holds nothing private. */
export function createPublicBannerRouter({ banners }: Pick<Options, 'banners'>): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => { sendPublic(response, { banners: await banners.listPublic() }) })
  return router
}
