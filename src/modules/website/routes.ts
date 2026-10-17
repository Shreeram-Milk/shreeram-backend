import { Router, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { websiteHomeSchema, type WebsiteHomeInput } from './schema.js'
import type { WebsiteHomeService } from './service.js'

type Options = { auth: AuthService; home: WebsiteHomeService; allowedOrigins: string[] }

/** `/admin/website/home`: only a signed-in admin can read or change the website's Home page. */
export function createAdminWebsiteRouter({ auth, home, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  router.get('/home', async (_request: Request, response: Response) => { response.json({ home: await home.get() }) })
  router.put('/home', validate('body', websiteHomeSchema), async (request: Request, response: Response) => {
    const actor = { adminId: (request.admin as { id: string }).id, ip: request.ip ?? null }
    response.json({ home: await home.save(request.body as WebsiteHomeInput, actor) })
  })
  return router
}

/** `/public/website/home`: what the public website reads to draw its Home page. No sign-in; it holds nothing private. */
export function createPublicWebsiteRouter({ home }: Pick<Options, 'home'>): Router {
  const router = Router()
  router.get('/home', async (_request: Request, response: Response) => { sendPublic(response, { home: await home.getPublic() }) })
  return router
}
