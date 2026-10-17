import { z } from 'zod'

export const POLICY_TYPES = ['privacy', 'terms', 'refund', 'cancellation', 'subscription', 'delivery'] as const
export type PolicyType = (typeof POLICY_TYPES)[number]

export const POLICY_TITLES: Record<PolicyType, string> = {
  privacy: 'Privacy Policy', terms: 'Terms & Conditions', refund: 'Refund Policy', cancellation: 'Cancellation Policy', subscription: 'Subscription Policy', delivery: 'Delivery Policy',
}
export const MAX_BODY_LENGTH = 20_000
/** Publishing needs real text, not a stub. */
export const MIN_PUBLISHED_BODY_LENGTH = 50

/** `2026-10-10` that is also a real calendar day (so 2026-02-30 is refused). */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default('')

/** One version of one legal document, as staff write it. */
export const policyInputSchema = z.object({
  type: z.enum(POLICY_TYPES),
  titleEn: z.string().trim().min(1, 'Enter the title.').max(120, 'Keep the title under 120 characters.'),
  titleGu: text(120),
  bodyEn: z.string().trim().min(1, 'Enter the policy text.').max(MAX_BODY_LENGTH, `Keep the text under ${MAX_BODY_LENGTH} characters.`),
  bodyGu: text(MAX_BODY_LENGTH),
  version: z.string().trim().min(1, 'Enter a version.').max(20, 'Keep the version under 20 characters.'),
  effectiveDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the date this takes effect.').refine(isRealDate, 'That date does not exist.'),
})

export const policyIdParamsSchema = z.object({ id: z.uuid('That is not a valid policy id.') })
export const legalPageParamsSchema = z.object({ type: z.enum(POLICY_TYPES) })
export const legalPageQuerySchema = z.object({ lang: z.enum(['en', 'gu']).default('en') })

export type PolicyInput = z.infer<typeof policyInputSchema>
export type PolicyStatus = 'draft' | 'published' | 'archived'
