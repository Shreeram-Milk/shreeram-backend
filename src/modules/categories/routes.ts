import { Router, type NextFunction, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import { ValidationError } from '../../http/validate.js'
import type { AuditWriter } from '../audit/audit.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { MediaPurpose } from '../media/schema.js'
import { createSimpleRecordRouter, createSimpleRecordService } from '../master-data/simple-records.js'
import type { Category, CategoryRepository } from './repository.js'
import { categoryInputSchema, type CategoryInput } from './schema.js'

export const createCategoryService = (options: { repository: CategoryRepository; audit: AuditWriter }) =>
  createSimpleRecordService<Category, CategoryInput>({ ...options, noun: 'category', notFoundCode: 'CATEGORY_NOT_FOUND', auditPrefix: 'category' })
export type CategoryService = ReturnType<typeof createCategoryService>

type MediaCheck = { isReady(id: string, purpose: MediaPurpose): Promise<boolean> }

/**
 * `/admin/categories`: only a signed-in admin can read or change categories. A tile picture must be one uploaded for a
 * category that finished uploading; anything else is refused before the category is saved.
 */
export function createAdminCategoryRouter(options: { auth: AuthService; categories: CategoryService; allowedOrigins: string[]; media?: MediaCheck }): Router {
  const router = Router()
  if (options.media) {
    const media = options.media
    // Signed-in staff only, before any picture is looked up.
    router.use(requireTrustedOrigin(options.allowedOrigins), requireAdmin(options.auth))
    router.use(async (request: Request, _response: Response, next: NextFunction) => {
      const imageAssetId = (request.body as { imageAssetId?: unknown } | undefined)?.imageAssetId
      if ((request.method === 'POST' || request.method === 'PUT') && typeof imageAssetId === 'string' && imageAssetId) {
        try {
          if (!(await media.isReady(imageAssetId, 'category'))) return next(new ValidationError([{ field: 'imageAssetId', message: 'That picture has not finished uploading. Upload it again.' }]))
        } catch (error) { return next(error) }
      }
      next()
    })
  }
  router.use(createSimpleRecordRouter<Category, CategoryInput>({ auth: options.auth, service: options.categories, allowedOrigins: options.allowedOrigins, inputSchema: categoryInputSchema, key: 'category' }))
  return router
}

/** `/public/categories`: the shelves the app shows (active categories only, in display order), each with its tile picture. No sign-in; nothing private in it. */
export function createPublicCategoryRouter({ categories }: { categories: CategoryService }): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => {
    const active = (await categories.listAll()).filter(category => category.status === 'active').sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    sendPublic(response, { categories: active.map(({ id, name, nameGu, description, sortOrder, imageUrl }) => ({ id, name, nameGu, description, sortOrder, imageUrl: imageUrl ?? null })) })
  })
  return router
}
