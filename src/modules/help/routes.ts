import { Router, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { faqIdParamsSchema, faqInputSchema, faqListQuerySchema, faqStatusSchema, type FaqInput, type FaqListQuery, type FaqStatus } from './schema.js'
import type { HelpService } from './service.js'

type Options = { auth: AuthService; help: HelpService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/help/faqs`: only a signed-in admin can read or change the help questions. */
export function createAdminHelpRouter({ auth, help, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/faqs', validate('query', faqListQuerySchema), async (request: Request, response: Response) => { response.json(await help.list(request.query as unknown as FaqListQuery)) })
  router.get('/faqs/:id', validate('params', faqIdParamsSchema), async (request: Request, response: Response) => { response.json({ faq: await help.get(idOf(request)) }) })
  router.post('/faqs', validate('body', faqInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ faq: await help.create(request.body as FaqInput, actorOf(request)) })
  })
  router.put('/faqs/:id', validate('params', faqIdParamsSchema), validate('body', faqInputSchema), async (request: Request, response: Response) => {
    response.json({ faq: await help.update(idOf(request), request.body as FaqInput, actorOf(request)) })
  })
  router.patch('/faqs/:id/status', validate('params', faqIdParamsSchema), validate('body', faqStatusSchema), async (request: Request, response: Response) => {
    response.json({ faq: await help.setStatus(idOf(request), (request.body as { status: FaqStatus }).status, actorOf(request)) })
  })
  return router
}

/** `/public/help`: the topics and published questions the app's Help screen shows. No sign-in; it holds nothing private. */
export function createPublicHelpRouter({ help }: Pick<Options, 'help'>): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => { sendPublic(response, await help.getPublic()) })
  return router
}
