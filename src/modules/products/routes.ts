import { Router, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { recordIdParamsSchema } from '../master-data/shared.js'
import { productCreditExclusionSchema, productInputSchema, productListQuerySchema, productStatusSchema, publicProductQuerySchema, type ProductInput, type ProductListQuery, type PublicProductQuery } from './schema.js'
import type { ProductService } from './service.js'

type Options = { auth: AuthService; products: ProductService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/admin/products`: only a signed-in admin can read or change products. */
export function createAdminProductRouter({ auth, products, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/', validate('query', productListQuerySchema), async (request: Request, response: Response) => { response.json(await products.list(request.query as unknown as ProductListQuery)) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json({ product: await products.get(idOf(request)) }) })
  router.post('/', validate('body', productInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ product: await products.create(request.body as ProductInput, actorOf(request)) })
  })
  router.put('/:id', validate('params', recordIdParamsSchema), validate('body', productInputSchema), async (request: Request, response: Response) => {
    response.json({ product: await products.update(idOf(request), request.body as ProductInput, actorOf(request)) })
  })
  router.patch('/:id/status', validate('params', recordIdParamsSchema), validate('body', productStatusSchema), async (request: Request, response: Response) => {
    response.json({ product: await products.setStatus(idOf(request), (request.body as { status: 'active' | 'inactive' }).status, actorOf(request)) })
  })
  router.patch('/:id/credit-exclusion', validate('params', recordIdParamsSchema), validate('body', productCreditExclusionSchema), async (request: Request, response: Response) => {
    response.json({ product: await products.setExcludedFromCredit(idOf(request), (request.body as { excludedFromCredit: boolean }).excludedFromCredit, actorOf(request)) })
  })
  return router
}

/** `/public/products`: the catalogue the app shows. Active products only; no sign-in; nothing private in it. */
export function createPublicProductRouter({ products }: Pick<Options, 'products'>): Router {
  const router = Router()
  router.get('/', validate('query', publicProductQuerySchema), async (request: Request, response: Response) => { sendPublic(response, await products.listPublic(request.query as unknown as PublicProductQuery)) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { sendPublic(response, { product: await products.getPublic(idOf(request)) }) })
  return router
}
