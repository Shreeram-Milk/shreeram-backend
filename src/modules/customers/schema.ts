import { z } from 'zod'
import { recordIdParamsSchema } from '../master-data/shared.js'

export const CUSTOMER_STATUSES = ['active', 'deleted'] as const
export const CUSTOMER_TYPES = ['prepaid', 'credit'] as const

export const customerListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>

/** What staff may change. Email, phone, language and sign-in details belong to the customer; `deleted` is only set by the customer. */
export const customerUpdateSchema = z.object({
  name: z.string().trim().max(100, 'Keep the name under 100 characters.'),
  customerType: z.enum(CUSTOMER_TYPES),
  adminNote: z.string().trim().max(500, 'Keep the note under 500 characters.'),
})
export type CustomerUpdate = z.infer<typeof customerUpdateSchema>

export { recordIdParamsSchema }
