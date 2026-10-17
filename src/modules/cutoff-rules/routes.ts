import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { pageQuerySchema, recordIdParamsSchema, statusChangeSchema, type PageQuery, type StatusChange } from '../master-data/shared.js'
import { cutoffRuleInputSchema, type CutoffRuleInput } from './schema.js'
import type { CutoffRuleService } from './service.js'

type Options = { auth: AuthService; rules: CutoffRuleService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/cutoff-rules`: only a signed-in admin can read or change cut-off rules. */
export function createAdminCutoffRuleRouter({ auth, rules, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', validate('query', pageQuerySchema), async (request: Request, response: Response) => { response.json(await rules.list(request.query as unknown as PageQuery)) })
  router.get('/all', async (_request: Request, response: Response) => { response.json({ rows: await rules.listAll() }) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ rule: await rules.get(idOf(request)) }) })
  router.get('/:id/usage', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ usage: await rules.usage(idOf(request)) }) })
  router.post('/', validate('body', cutoffRuleInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ rule: await rules.create(request.body as CutoffRuleInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', recordIdParamsSchema), validate('body', cutoffRuleInputSchema), async (request: Request, response: Response) => {
    response.json({ rule: await rules.update(idOf(request), request.body as CutoffRuleInput, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', recordIdParamsSchema), validate('body', statusChangeSchema), async (request: Request, response: Response) => {
    response.json({ rule: await rules.setStatus(idOf(request), request.body as StatusChange, actorOf(request)) })
  })
  router.delete('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => {
    await rules.remove(idOf(request), actorOf(request))
    response.status(204).end()
  })
  return router
}
