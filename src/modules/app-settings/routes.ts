import { Router, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { appSettingsSchema, type AppSettingsInput } from './schema.js'
import type { AppSettingsService } from './service.js'

type Options = { auth: AuthService; settings: AppSettingsService; allowedOrigins: string[] }

/** `/admin/app-settings`: only a signed-in admin can read or change the settings. */
export function createAdminAppSettingsRouter({ auth, settings, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  router.get('/', async (_request: Request, response: Response) => { response.json({ settings: await settings.get() }) })
  router.put('/', validate('body', appSettingsSchema), async (request: Request, response: Response) => {
    const actor = { adminId: (request.admin as { id: string }).id, ip: request.ip ?? null }
    response.json({ settings: await settings.save(request.body as AppSettingsInput, actor) })
  })
  return router
}

/** `/public/app-settings`: what the customer app reads at start-up. No sign-in; it holds nothing private. */
export function createPublicAppSettingsRouter({ settings }: Pick<Options, 'settings'>): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => { sendPublic(response, { settings: await settings.getPublic() }) })
  return router
}
