import { Router, type Request, type Response } from 'express'
import { sendPublic } from '../../http/public-cache.js'
import type { AuditWriter } from '../audit/audit.js'
import type { AuthService } from '../auth/service.js'
import { createSimpleRecordRouter, createSimpleRecordService } from '../master-data/simple-records.js'
import type { Category, CategoryRepository } from './repository.js'
import { categoryInputSchema, type CategoryInput } from './schema.js'

export const createCategoryService = (options: { repository: CategoryRepository; audit: AuditWriter }) =>
  createSimpleRecordService<Category, CategoryInput>({ ...options, noun: 'category', notFoundCode: 'CATEGORY_NOT_FOUND', auditPrefix: 'category' })
export type CategoryService = ReturnType<typeof createCategoryService>

/** `/admin/categories`: only a signed-in admin can read or change categories. */
export const createAdminCategoryRouter = (options: { auth: AuthService; categories: CategoryService; allowedOrigins: string[] }) =>
  createSimpleRecordRouter<Category, CategoryInput>({ auth: options.auth, service: options.categories, allowedOrigins: options.allowedOrigins, inputSchema: categoryInputSchema, key: 'category' })

/** `/public/categories`: the shelves the app shows (active categories only, in display order). No sign-in; nothing private in it. */
export function createPublicCategoryRouter({ categories }: { categories: CategoryService }): Router {
  const router = Router()
  router.get('/', async (_request: Request, response: Response) => {
    const active = (await categories.listAll()).filter(category => category.status === 'active').sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    sendPublic(response, { categories: active.map(({ id, name, nameGu, description, sortOrder }) => ({ id, name, nameGu, description, sortOrder })) })
  })
  return router
}
