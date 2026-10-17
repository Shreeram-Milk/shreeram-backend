import { z } from 'zod'
import { pageQuerySchema } from '../master-data/shared.js'

export const PRODUCT_STATUSES = ['draft', 'active', 'inactive'] as const
export const DELIVERY_METHODS = ['local_delivery', 'shipping'] as const
export const PURCHASE_METHODS = ['buy_once', 'trial', 'subscription'] as const
export const PRODUCT_BADGES = ['bestseller', 'new', 'seasonal'] as const
export const MAX_GALLERY_IMAGES = 10
export const MAX_HIGHLIGHTS = 6
export const MAX_HIGHLIGHT_LENGTH = 60
export const MAX_VARIANTS = 30

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default('')
const idOrNull = z.uuid('Choose one from the list.').nullable().default(null)
/** Trimmed, no blanks, no repeats; each line short and few lines. */
const highlights = z.array(z.string().trim().max(MAX_HIGHLIGHT_LENGTH, `Keep each highlight under ${MAX_HIGHLIGHT_LENGTH} characters.`)).default([])
  .transform(lines => [...new Set(lines.filter(Boolean))])
  .refine(lines => lines.length <= MAX_HIGHLIGHTS, `Add at most ${MAX_HIGHLIGHTS} highlights.`)

export const variantInputSchema = z.object({
  /** Present when editing a variant that already exists; absent for a new one. */
  id: z.uuid('That is not a valid variant id.').optional(),
  name: z.string().trim().min(1, 'Variant name is required.').max(60, 'Keep the variant name under 60 characters.'),
  sku: text(40),
  pricePaise: z.number().int('Use whole paise.').min(0, 'Price must be zero or greater.').max(100_000_000, 'That price is too high.'),
  compareAtPricePaise: z.number().int('Use whole paise.').nullable().default(null),
  status: z.enum(['active', 'inactive']).default('active'),
  displayUnit: z.string().trim().min(1, 'Display unit is required.').max(20, 'Keep the unit under 20 characters.'),
  displayQuantity: z.number().positive('Display quantity must be greater than zero.').max(1_000_000),
  productionUnit: text(20),
  productionQuantity: z.number().min(0, 'Use zero or greater.').max(1_000_000).default(0),
}).superRefine((variant, context) => {
  if (variant.compareAtPricePaise !== null && variant.compareAtPricePaise <= variant.pricePaise) context.addIssue({ code: 'custom', path: ['compareAtPricePaise'], message: 'The old price must be higher than the price.' })
})

export const productInputSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required.').max(100, 'Keep the name under 100 characters.'),
  nameGu: text(80),
  categoryId: z.uuid('Choose a category.'),
  sku: text(40),
  shortDescriptionEn: text(200),
  shortDescriptionGu: text(200),
  longDescriptionEn: text(2000),
  longDescriptionGu: text(2000),
  nutritionEn: text(1000),
  nutritionGu: text(1000),
  highlightsEn: highlights,
  highlightsGu: highlights,
  badges: z.array(z.enum(PRODUCT_BADGES)).default([]).transform(list => [...new Set(list)]),
  primaryImageAssetId: idOrNull,
  galleryAssetIds: z.array(z.uuid('Choose a picture.')).max(MAX_GALLERY_IMAGES, `Add at most ${MAX_GALLERY_IMAGES} gallery images.`).default([]),
  purchaseMethods: z.array(z.enum(PURCHASE_METHODS)).default([]).transform(list => [...new Set(list)]),
  /** How it reaches the customer: our own delivery to PIN codes, or courier shipping. */
  deliveryMethod: z.enum(DELIVERY_METHODS).nullable().default(null),
  /** Where it can be delivered. */
  serviceAreaId: idOrNull,
  /** Local delivery only: the last time to order for each delivery window. */
  cutoffRuleId: idOrNull,
  includeInProductionPlanning: z.boolean().default(false),
  /** A credit customer cannot buy this product on credit: it has to be paid for when ordering. */
  excludedFromCredit: z.boolean().default(false),
  trialPlanIds: z.array(z.uuid('Choose a trial plan.')).default([]).transform(list => [...new Set(list)]),
  subscriptionRuleIds: z.array(z.uuid('Choose a subscription rule.')).default([]).transform(list => [...new Set(list)]),
  status: z.enum(PRODUCT_STATUSES).default('draft'),
  variants: z.array(variantInputSchema).max(MAX_VARIANTS, `Add at most ${MAX_VARIANTS} variants.`).default([]),
}).superRefine((product, context) => {
  const names = product.variants.map(variant => variant.name.toLowerCase())
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', path: ['variants'], message: 'Variant names must be unique.' })
  const skus = product.variants.map(variant => variant.sku.toLowerCase()).filter(Boolean)
  if (new Set(skus).size !== skus.length) context.addIssue({ code: 'custom', path: ['variants'], message: 'Variant SKUs must be unique.' })
  if (product.deliveryMethod === 'shipping' && (product.cutoffRuleId || product.includeInProductionPlanning)) context.addIssue({ code: 'custom', path: ['deliveryMethod'], message: 'Shipping cannot use a cut-off rule or production planning.' })
  // Trials and subscriptions need a delivery window every day; a courier has none.
  if (product.deliveryMethod === 'shipping' && product.purchaseMethods.some(method => method !== 'buy_once')) context.addIssue({ code: 'custom', path: ['purchaseMethods'], message: 'Courier products can only be bought once (no trial or subscription).' })
  if (product.cutoffRuleId && !product.serviceAreaId) context.addIssue({ code: 'custom', path: ['serviceAreaId'], message: 'Choose a delivery area for the cut-off rule.' })
  // A draft may be saved half-finished; a live or inactive product is what customers (or old orders) rely on, so it must be complete.
  if (product.status === 'draft') return
  if (!product.variants.some(variant => variant.status === 'active')) context.addIssue({ code: 'custom', path: ['variants'], message: 'Add at least one active variant before publishing.' })
  if (product.purchaseMethods.length === 0) context.addIssue({ code: 'custom', path: ['purchaseMethods'], message: 'Select at least one purchase method.' })
  if (product.includeInProductionPlanning && product.variants.some(variant => variant.status === 'active' && (!variant.productionUnit || variant.productionQuantity <= 0))) context.addIssue({ code: 'custom', path: ['variants'], message: 'Production planning is on, so every active variant needs a production unit and a quantity greater than zero.' })
  if (!product.deliveryMethod) context.addIssue({ code: 'custom', path: ['deliveryMethod'], message: 'Choose how this product is delivered.' })
  if (!product.serviceAreaId) context.addIssue({ code: 'custom', path: ['serviceAreaId'], message: 'Choose a delivery area.' })
  if (product.purchaseMethods.includes('trial') && product.trialPlanIds.length === 0) context.addIssue({ code: 'custom', path: ['trialPlanIds'], message: 'Select at least one trial plan.' })
  if (product.purchaseMethods.includes('subscription') && product.subscriptionRuleIds.length === 0) context.addIssue({ code: 'custom', path: ['subscriptionRuleIds'], message: 'Select at least one subscription schedule.' })
})

export const productCreditExclusionSchema = z.object({ excludedFromCredit: z.boolean() })
export const productStatusSchema = z.object({ status: z.enum(['active', 'inactive']) })
export const productListQuerySchema = pageQuerySchema.extend({
  status: z.enum(PRODUCT_STATUSES).optional(),
  categoryId: z.uuid().optional(),
})
export const publicProductQuerySchema = z.object({
  category: z.uuid().optional(),
  search: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export type ProductInput = z.infer<typeof productInputSchema>
export type VariantInput = z.infer<typeof variantInputSchema>
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number]
export type PurchaseMethod = (typeof PURCHASE_METHODS)[number]
export type ProductListQuery = z.infer<typeof productListQuerySchema>
export type PublicProductQuery = z.infer<typeof publicProductQuerySchema>
