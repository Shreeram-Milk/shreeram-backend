import { AppError } from '../../http/errors.js'
import { ValidationError, type FieldIssue } from '../../http/validate.js'
import type { ObjectStorage } from '../../integrations/storage/storage.js'
import type { AuditWriter } from '../audit/audit.js'
import { nameTakenError, notFoundError } from '../master-data/shared.js'
import type { Product, ProductRepository, ProductSummary, PublicProduct, PublicProductDetail } from './repository.js'
import { MAX_GALLERY_IMAGES, type ProductInput, type ProductListQuery, type ProductStatus, type PublicProductQuery } from './schema.js'

type Dependencies = { repository: ProductRepository; audit: AuditWriter; storage: Pick<ObjectStorage, 'createDownloadUrl'> }
type Actor = { adminId: string; ip: string | null }

type ImageView = { assetId: string; url: string }
/** What the admin screens read: the product with short-lived picture links. Storage keys never leave the backend. */
export type AdminProduct = Omit<Product, 'primaryImage' | 'gallery'> & { primaryImage: ImageView | null; gallery: ImageView[] }
export type AdminProductSummary = Omit<ProductSummary, 'primaryImageKey'> & { imageUrl: string | null }

type PublicVariant = { id: string; name: string; pricePaise: number; compareAtPricePaise: number | null; displayUnit: string; displayQuantity: number }
/** What the customer app reads for a product on a list. Only what it shows: no SKU, status or staff text. */
export type PublicProductView = {
  id: string; name: string; nameGu: string; categoryId: string; categoryName: string; categoryNameGu: string; shortDescriptionEn: string; shortDescriptionGu: string
  badges: string[]; purchaseMethods: string[]; imageUrl: string | null; priceFromPaise: number; variants: PublicVariant[]
}
export type PublicProductDetailView = PublicProductView & {
  longDescriptionEn: string; longDescriptionGu: string; nutritionEn: string; nutritionGu: string; highlightsEn: string[]; highlightsGu: string[]; galleryUrls: string[]
  trialPlans: PublicProductDetail['trialPlans']; subscriptionRules: PublicProductDetail['subscriptionRules']
}

const notFound = () => notFoundError('PRODUCT_NOT_FOUND', 'product')
const invalid = (field: string, message: string) => new ValidationError([{ field, message }])

export function createProductService({ repository, audit, storage }: Dependencies) {
  const urlOf = (key: string | null) => (key ? storage.createDownloadUrl(key) : Promise.resolve(null))

  const toAdminProduct = async (product: Product): Promise<AdminProduct> => {
    const [primary, gallery] = await Promise.all([
      product.primaryImage ? storage.createDownloadUrl(product.primaryImage.key) : Promise.resolve(null),
      Promise.all(product.gallery.map(async image => ({ assetId: image.assetId, url: await storage.createDownloadUrl(image.key) }))),
    ])
    // Rebuilt field by field so a storage key can never slip into a response.
    return { ...product, primaryImage: product.primaryImage && primary ? { assetId: product.primaryImage.assetId, url: primary } : null, gallery }
  }

  const toPublicView = async (product: PublicProduct): Promise<PublicProductView> => ({
    id: product.id, name: product.name, nameGu: product.nameGu, categoryId: product.categoryId, categoryName: product.categoryName, categoryNameGu: product.categoryNameGu,
    shortDescriptionEn: product.shortDescriptionEn, shortDescriptionGu: product.shortDescriptionGu, badges: product.badges, purchaseMethods: product.purchaseMethods,
    imageUrl: await urlOf(product.primaryImage?.key ?? null), priceFromPaise: Math.min(...product.variants.map(variant => variant.pricePaise)),
    variants: product.variants.map(variant => ({ id: variant.id, name: variant.name, pricePaise: variant.pricePaise, compareAtPricePaise: variant.compareAtPricePaise, displayUnit: variant.displayUnit, displayQuantity: variant.displayQuantity })),
  })

  /**
   * The rules that need other records. The shape of the input was already checked by the schema.
   * Something the product already uses may stay even if it was switched off later; choosing something new needs it to be active.
   * Returns the input with the details the server decides: links that do not apply are dropped, the gallery is cleaned.
   */
  async function prepare(input: ProductInput, current?: Product): Promise<ProductInput> {
    const issues: FieldIssue[] = []
    const category = await repository.categoryStatus(input.categoryId)
    if (!category) issues.push({ field: 'categoryId', message: 'Choose a category.' })
    else if (category !== 'active' && current?.categoryId !== input.categoryId) issues.push({ field: 'categoryId', message: 'Choose an active category.' })

    if (input.serviceAreaId) {
      const area = await repository.areaInfo(input.serviceAreaId)
      if (!area) issues.push({ field: 'serviceAreaId', message: 'That delivery area does not exist.' })
      else if (area.status !== 'active' && current?.serviceAreaId !== input.serviceAreaId) issues.push({ field: 'serviceAreaId', message: 'Choose an active delivery area.' })
      else if (input.deliveryMethod === 'local_delivery' && area.coverageType !== 'pin_code') issues.push({ field: 'serviceAreaId', message: 'Local delivery needs a delivery area made of PIN codes.' })
      else if (input.deliveryMethod === 'shipping' && area.coverageType === 'pin_code') issues.push({ field: 'serviceAreaId', message: 'Shipping needs a delivery area covering a state or all of India.' })
    }
    if (input.cutoffRuleId) {
      const status = await repository.cutoffRuleStatus(input.cutoffRuleId)
      if (!status) issues.push({ field: 'cutoffRuleId', message: 'That cut-off rule does not exist.' })
      else if (status !== 'active' && current?.cutoffRuleId !== input.cutoffRuleId) issues.push({ field: 'cutoffRuleId', message: 'Choose an active cut-off rule.' })
    }

    const trialPlanIds = input.purchaseMethods.includes('trial') ? input.trialPlanIds : []
    const subscriptionRuleIds = input.purchaseMethods.includes('subscription') ? input.subscriptionRuleIds : []
    if (trialPlanIds.length > 0) {
      const found = await repository.trialPlanStatuses(trialPlanIds)
      for (const id of trialPlanIds) {
        const status = found.get(id)
        if (!status) issues.push({ field: 'trialPlanIds', message: 'One of the trial plans does not exist.' })
        else if (status !== 'active' && !current?.trialPlanIds.includes(id)) issues.push({ field: 'trialPlanIds', message: 'Choose active trial plans.' })
      }
    }
    if (subscriptionRuleIds.length > 0) {
      const found = await repository.ruleStatuses(subscriptionRuleIds)
      for (const id of subscriptionRuleIds) {
        const status = found.get(id)
        if (!status) issues.push({ field: 'subscriptionRuleIds', message: 'One of the subscription rules does not exist.' })
        else if (status !== 'active' && !current?.subscriptionRuleIds.includes(id)) issues.push({ field: 'subscriptionRuleIds', message: 'Choose active subscription rules.' })
      }
    }

    // The main picture is not repeated in the gallery. Every chosen picture must be a finished product upload.
    const galleryAssetIds = [...new Set(input.galleryAssetIds)].filter(id => id !== input.primaryImageAssetId)
    if (galleryAssetIds.length > MAX_GALLERY_IMAGES) issues.push({ field: 'galleryAssetIds', message: `Add at most ${MAX_GALLERY_IMAGES} gallery images.` })
    const wanted = [input.primaryImageAssetId, ...galleryAssetIds].filter((id): id is string => Boolean(id))
    if (wanted.length > 0) {
      const ready = await repository.readyProductImages(wanted)
      if (input.primaryImageAssetId && !ready.has(input.primaryImageAssetId)) issues.push({ field: 'primaryImageAssetId', message: 'That picture has not finished uploading. Upload it again.' })
      if (galleryAssetIds.some(id => !ready.has(id))) issues.push({ field: 'galleryAssetIds', message: 'A gallery picture has not finished uploading. Upload it again.' })
    }

    // A variant id must belong to this product: an id from another product (or a made-up one) is refused.
    const ownVariantIds = new Set(current?.variants.map(variant => variant.id))
    input.variants.forEach((variant, index) => { if (variant.id && !ownVariantIds.has(variant.id)) issues.push({ field: `variants.${index}.id`, message: 'That variant does not belong to this product.' }) })
    if (issues.length > 0) throw new ValidationError(issues)

    if (await repository.nameExists(input.name, current?.id)) throw nameTakenError()
    if (input.sku && (await repository.skuTaken(input.sku, current?.id))) throw new AppError(409, 'SKU_TAKEN', 'This SKU is already used by another product.')
    if (await repository.variantSkuTaken(input.variants.map(variant => variant.sku).filter(Boolean), current?.id)) throw new AppError(409, 'SKU_TAKEN', 'A variant SKU is already used by another product.')
    return { ...input, trialPlanIds, subscriptionRuleIds, galleryAssetIds }
  }

  /** Customers have paid for (or are being charged for) deliveries of a running subscription or trial, so such a product cannot be switched off. */
  async function ensureNoRunningPlans(product: Product): Promise<void> {
    const running = await repository.runningPlanCount(product.id)
    if (running > 0) {
      throw new AppError(409, 'PRODUCT_HAS_RUNNING_PLANS', `${product.name} cannot be switched off: ${running} ${running === 1 ? 'subscription or trial is' : 'subscriptions or trials are'} still running. Wait until they finish, or cancel them first.`, { running })
    }
  }

  /** Why a stored product cannot go live yet, in plain words, or null when it can. The same rules the form enforces, repeated for the status switch. */
  async function notReadyReason(product: Product): Promise<string | null> {
    if (!product.variants.some(variant => variant.status === 'active')) return 'Add at least one active variant first.'
    if (product.purchaseMethods.length === 0) return 'Select at least one purchase method first.'
    if (!product.deliveryMethod || !product.serviceAreaId) return 'Choose how this product is delivered and its delivery area first.'
    if (product.purchaseMethods.includes('trial') && product.trialPlanIds.length === 0) return 'Select at least one trial plan first.'
    if (product.purchaseMethods.includes('subscription') && product.subscriptionRuleIds.length === 0) return 'Select at least one subscription schedule first.'
    if ((await repository.categoryStatus(product.categoryId)) !== 'active') return 'The category is switched off. Choose an active category first.'
    if ((await repository.areaInfo(product.serviceAreaId))?.status !== 'active') return 'The delivery area is switched off. Choose an active one first.'
    return null
  }

  async function get(id: string): Promise<Product> {
    const product = await repository.findById(id)
    if (!product) throw notFound()
    return product
  }

  return {
    async list(query: ProductListQuery): Promise<{ rows: AdminProductSummary[]; total: number }> {
      const { rows, total } = await repository.list(query)
      return { total, rows: await Promise.all(rows.map(async ({ primaryImageKey, ...summary }) => ({ ...summary, imageUrl: await urlOf(primaryImageKey) }))) }
    },
    async get(id: string): Promise<AdminProduct> { return toAdminProduct(await get(id)) },

    async create(input: ProductInput, actor: Actor): Promise<AdminProduct> {
      if (input.variants.some(variant => variant.id)) throw invalid('variants', 'A new product cannot reuse existing variants.')
      const product = await repository.create(await prepare(input), actor.adminId)
      await audit({ adminId: actor.adminId, action: 'product_created', details: { productId: product.id }, ip: actor.ip })
      return toAdminProduct(product)
    },

    async update(id: string, input: ProductInput, actor: Actor): Promise<AdminProduct> {
      const current = await get(id)
      if (current.status !== 'inactive' && input.status === 'inactive') await ensureNoRunningPlans(current)
      // Draft is where a product starts; once it has gone live it can be switched off but not made a draft again.
      if (current.status !== 'draft' && input.status === 'draft') throw new AppError(409, 'PRODUCT_CANNOT_RETURN_TO_DRAFT', 'A product that has been published can be switched off, but not made a draft again.')
      const product = await repository.update(id, await prepare(input, current), actor.adminId)
      if (!product) throw notFound()
      await audit({ adminId: actor.adminId, action: 'product_updated', details: { productId: id }, ip: actor.ip })
      return toAdminProduct(product)
    },

    async setStatus(id: string, status: Exclude<ProductStatus, 'draft'>, actor: Actor): Promise<AdminProduct> {
      const current = await get(id)
      if (status === 'inactive' && current.status !== 'inactive') await ensureNoRunningPlans(current)
      if (status === 'active') {
        const reason = await notReadyReason(current)
        if (reason) throw new AppError(409, 'PRODUCT_NOT_READY', reason)
      }
      const product = await repository.setStatus(id, status, actor.adminId)
      if (!product) throw notFound()
      await audit({ adminId: actor.adminId, action: 'product_status_changed', details: { productId: id, status }, ip: actor.ip })
      return toAdminProduct(product)
    },

    async setExcludedFromCredit(id: string, excluded: boolean, actor: Actor): Promise<AdminProduct> {
      await get(id)
      const product = await repository.setExcludedFromCredit(id, excluded, actor.adminId)
      if (!product) throw notFound()
      await audit({ adminId: actor.adminId, action: 'product_credit_exclusion_changed', details: { productId: id, excludedFromCredit: excluded }, ip: actor.ip })
      return toAdminProduct(product)
    },

    async listPublic(query: PublicProductQuery): Promise<{ products: PublicProductView[]; total: number; page: number; pageSize: number }> {
      const { rows, total } = await repository.listPublic(query)
      return { products: await Promise.all(rows.map(toPublicView)), total, page: query.page, pageSize: query.pageSize }
    },

    async getPublic(id: string): Promise<PublicProductDetailView> {
      const detail = await repository.findPublic(id)
      if (!detail) throw notFound()
      const base = await toPublicView({ ...detail, categoryName: detail.categoryName, categoryNameGu: detail.categoryNameGu })
      return {
        ...base, longDescriptionEn: detail.longDescriptionEn, longDescriptionGu: detail.longDescriptionGu, nutritionEn: detail.nutritionEn, nutritionGu: detail.nutritionGu,
        highlightsEn: detail.highlightsEn, highlightsGu: detail.highlightsGu, galleryUrls: await Promise.all(detail.gallery.map(image => storage.createDownloadUrl(image.key))),
        trialPlans: detail.trialPlans, subscriptionRules: detail.subscriptionRules,
      }
    },
  }
}

export type ProductService = ReturnType<typeof createProductService>
