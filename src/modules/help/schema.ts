import { z } from 'zod'

/** The fixed help topics (seeded by migration 0006). Customer issue reports will use the same list. */
export const HELP_TOPIC_IDS = ['delivery_missing', 'late_delivery', 'wrong_product', 'quality_issue', 'payment_issue', 'subscription_issue', 'address_issue', 'other'] as const
export const FAQ_STATUSES = ['draft', 'published', 'inactive'] as const
/** Most questions the Help screen can highlight as popular. */
export const MAX_FEATURED_FAQS = 5
export const MAX_KEYWORDS = 10

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default('')
/** "Milk", " late ", "milk" -> ["milk", "late"]: lower-case, trimmed, no blanks or repeats. */
const keywords = z.array(z.string().trim().max(40, 'Keep each keyword under 40 characters.')).max(MAX_KEYWORDS, `Add at most ${MAX_KEYWORDS} keywords.`).default([])
  .transform(list => [...new Set(list.map(word => word.toLowerCase()).filter(Boolean))])

export const faqInputSchema = z.object({
  topic: z.enum(HELP_TOPIC_IDS),
  questionEn: z.string().trim().min(1, 'Enter the question.').max(160, 'Keep the question under 160 characters.'),
  questionGu: text(160),
  answerEn: z.string().trim().min(1, 'Enter the answer.').max(800, 'Keep the answer under 800 characters.'),
  answerGu: text(800),
  searchKeywords: keywords,
  featured: z.boolean().default(false),
  sortOrder: z.number().int('Use a whole number.').min(0, 'Use zero or greater.').max(10_000).default(0),
  status: z.enum(FAQ_STATUSES).default('draft'),
})

export const faqStatusSchema = z.object({ status: z.enum(FAQ_STATUSES) })
export const faqIdParamsSchema = z.object({ id: z.uuid('That is not a valid question id.') })
export const faqListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  topic: z.enum(HELP_TOPIC_IDS).optional(),
  status: z.enum(FAQ_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type FaqInput = z.infer<typeof faqInputSchema>
export type FaqStatus = (typeof FAQ_STATUSES)[number]
export type FaqListQuery = z.infer<typeof faqListQuerySchema>
