import { Router, type Request, type Response } from 'express'
import { sendPublic, sendPublicHtml } from '../../http/public-cache.js'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { renderLegalNotFound, renderLegalPage } from './legal-page.js'
import { legalPageParamsSchema, legalPageQuerySchema, policyIdParamsSchema, policyInputSchema, POLICY_TITLES, type PolicyInput, type PolicyType } from './schema.js'
import type { PolicyService } from './service.js'

type Options = { auth: AuthService; policies: PolicyService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/policies`: only a signed-in admin can read or change policy versions. */
export function createAdminPolicyRouter({ auth, policies, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', async (_request: Request, response: Response) => { response.json({ policies: await policies.list() }) })
  router.get('/:id', validate('params', policyIdParamsSchema), async (request: Request, response: Response) => { response.json({ policy: await policies.get(idOf(request)) }) })
  router.post('/', validate('body', policyInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ policy: await policies.create(request.body as PolicyInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', policyIdParamsSchema), validate('body', policyInputSchema), async (request: Request, response: Response) => {
    response.json({ policy: await policies.updateDraft(idOf(request), request.body as PolicyInput, actorOf(request)) })
  })
  router.post('/:id/new-version', validate('params', policyIdParamsSchema), async (request: Request, response: Response) => {
    response.status(201).json({ policy: await policies.startNewVersion(idOf(request), actorOf(request)) })
  })
  router.post('/:id/publish', validate('params', policyIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ policy: await policies.publish(idOf(request), actorOf(request)) })
  })
  router.post('/:id/archive', validate('params', policyIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ policy: await policies.archive(idOf(request), actorOf(request)) })
  })
  router.delete('/:id', validate('params', policyIdParamsSchema), async (request: Request, response: Response) => {
    await policies.discardDraft(idOf(request), actorOf(request))
    response.status(204).end()
  })
  return router
}

/** `/public/policies`: the published policies the customer app shows. No sign-in; legal documents are public by nature. */
export function createPublicPolicyRouter({ policies }: Pick<Options, 'policies'>): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => { sendPublic(response, { policies: await policies.getPublic() }) })
  return router
}

/** `/legal/:type`: the same documents as ordinary web pages, which the App Store and Google Play ask for (a link anyone can open). */
export function createLegalPageRouter({ policies }: Pick<Options, 'policies'>): Router {
  const router = Router()
  router.get('/:type', validate('params', legalPageParamsSchema), validate('query', legalPageQuerySchema), async (request: Request, response: Response) => {
    const type = (request.params as { type: PolicyType }).type
    const language = (request.query as unknown as { lang: 'en' | 'gu' }).lang
    const policy = await policies.getPublicByType(type)
    if (!policy) { response.status(404).type('html').send(renderLegalNotFound(POLICY_TITLES[type])); return }
    sendPublicHtml(response, renderLegalPage(policy, language))
  })
  return router
}
