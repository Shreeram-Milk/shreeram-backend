import { z } from 'zod'

export const OFFER_KINDS = ['percent', 'flat', 'free_gift'] as const
export const OFFER_SCOPES = ['order', 'products'] as const
export const OFFER_STATUSES = ['active', 'inactive'] as const
export type OfferKind = (typeof OFFER_KINDS)[number]
export type PurchaseKind = 'one_time' | 'trial' | 'subscription'

/** `2026-10-10` that is also a real calendar day (so 2026-02-30 is refused). */
function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const dateOrNull = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.').refine(isRealDate, 'That date does not exist.').nullable().default(null)
const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`)
const positiveOrNull = (label: string) => z.number().int('Use a whole number.').min(1, `${label} must be at least 1.`).max(100_000_000).nullable().default(null)

/** A code is typed by customers, so it is upper-case letters and digits only. An empty code means the offer applies by itself. */
const codeSchema = z.string().trim().toUpperCase().default('').transform(value => (value === '' ? null : value)).refine(value => value === null || /^[A-Z0-9]{3,20}$/.test(value), 'Use 3 to 20 letters and numbers, with no spaces.')

export const offerInputSchema = z.object({
  title: text(80).min(1, 'Enter a title.'),
  titleGu: text(80).default(''),
  description: text(300).default(''),
  descriptionGu: text(300).default(''),
  kind: z.enum(OFFER_KINDS),
  /** Percent off, 1 to 99: an offer never makes the whole order free. */
  percent: z.number().int('Use a whole number.').min(1, 'Use 1 to 99.').max(99, 'Use 1 to 99.').nullable().default(null),
  /** Flat amount off, in paise. */
  flatPaise: positiveOrNull('The amount'),
  /** The most one checkout can get off ("20% off, up to Rs 100"). Empty means no cap. */
  maxDiscountPaise: positiveOrNull('The cap'),
  minOrderPaise: z.number().int('Use a whole number.').min(0).max(100_000_000).default(0),
  scope: z.enum(OFFER_SCOPES).default('order'),
  /** For scope "products": the products that count. For a free gift: the products that earn it. */
  productIds: z.array(z.uuid('That is not a valid product id.')).max(50, 'Choose at most 50 products.').default([]),
  appliesOneTime: z.boolean().default(true),
  appliesTrial: z.boolean().default(false),
  appliesSubscription: z.boolean().default(false),
  /** A subscription offer such as "30 days or more". Empty means any length. */
  minPlanDays: positiveOrNull('The plan length'),
  giftVariantId: z.uuid('That is not a valid product size.').nullable().default(null),
  giftQuantity: z.number().int('Use a whole number.').min(1).max(20).default(1),
  code: codeSchema,
  startsOn: dateOrNull,
  endsOn: dateOrNull,
  totalLimit: positiveOrNull('The limit'),
  perCustomerLimit: positiveOrNull('The limit'),
  status: z.enum(OFFER_STATUSES).default('active'),
}).superRefine((value, context) => {
  const problem = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
  if (value.kind === 'percent') {
    if (value.percent === null) problem('percent', 'Enter the percent off.')
    if (value.flatPaise !== null) problem('flatPaise', 'A percent offer has no flat amount.')
  }
  if (value.kind === 'flat') {
    if (value.flatPaise === null) problem('flatPaise', 'Enter the amount off.')
    if (value.percent !== null) problem('percent', 'A flat offer has no percent.')
  }
  if (value.kind !== 'free_gift' && value.giftVariantId !== null) problem('giftVariantId', 'Only a free-gift offer has a gift.')
  if (value.kind === 'flat' && value.maxDiscountPaise !== null) problem('maxDiscountPaise', 'A cap only makes sense for a percent offer.')
  if (value.kind === 'free_gift') {
    if (value.giftVariantId === null) problem('giftVariantId', 'Choose the free product.')
    if (value.productIds.length === 0) problem('productIds', 'Choose the products that earn the gift.')
    if (value.percent !== null || value.flatPaise !== null) problem('percent', 'A free-gift offer has no money off.')
  }
  if (value.scope === 'products' && value.productIds.length === 0) problem('productIds', 'Choose at least one product.')
  if (value.scope === 'order' && value.kind !== 'free_gift' && value.productIds.length > 0) problem('productIds', 'Remove the products, or choose "Only some products".')
  if (!value.appliesOneTime && !value.appliesTrial && !value.appliesSubscription) problem('appliesOneTime', 'Choose where this offer works.')
  if (value.minPlanDays !== null && !value.appliesSubscription) problem('minPlanDays', 'A plan length only applies to subscriptions.')
  if (value.startsOn && value.endsOn && value.endsOn < value.startsOn) problem('endsOn', 'The end date must be on or after the start date.')
})
export type OfferInput = z.infer<typeof offerInputSchema>

export const offerStatusSchema = z.object({ status: z.enum(OFFER_STATUSES) })
export const offerIdParamsSchema = z.object({ id: z.uuid('That is not a valid offer id.') })
