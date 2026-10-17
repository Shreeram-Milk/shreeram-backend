import { withTransaction } from '../../db/transaction.js'
import type { Database } from '../../db/pool.js'
import { guardUnique, likePattern, type RecordStatus } from '../master-data/shared.js'
import type { CoverageType } from '../service-areas/schema.js'
import type { DeliveryMethod, ProductInput, ProductListQuery, ProductStatus, PublicProductQuery, PurchaseMethod, VariantInput } from './schema.js'

export type ProductVariant = Omit<VariantInput, 'id'> & { id: string }
/** A stored picture: its id (what the admin links) and its private storage key (turned into a short-lived link by the service). */
export type StoredImage = { assetId: string; key: string }

type ProductFields = Omit<ProductInput, 'variants' | 'primaryImageAssetId' | 'galleryAssetIds'>
export type Product = ProductFields & { id: string; updatedAt: string; variants: ProductVariant[]; primaryImage: StoredImage | null; gallery: StoredImage[] }

/** One line of the admin product list. */
export type ProductSummary = {
  id: string; name: string; nameGu: string; categoryId: string; categoryName: string; sku: string; status: ProductStatus
  purchaseMethods: PurchaseMethod[]; deliveryMethod: DeliveryMethod | null; serviceAreaName: string | null; excludedFromCredit: boolean; variantCount: number; priceFromPaise: number | null; primaryImageKey: string | null; updatedAt: string
}

/** What the customer app needs for a product on a list: only active variants, with the category's names. */
export type PublicProduct = Pick<Product, 'id' | 'name' | 'nameGu' | 'categoryId' | 'shortDescriptionEn' | 'shortDescriptionGu' | 'badges' | 'purchaseMethods' | 'variants' | 'primaryImage'> & { categoryName: string; categoryNameGu: string }
/** Plus everything for the product page: long text, gallery, and the trial plans and subscription rules on offer. */
export type PublicProductDetail = Product & { categoryName: string; categoryNameGu: string; trialPlans: Array<{ id: string; name: string; durationDays: number }>; subscriptionRules: Array<{ id: string; name: string; systemType: string; lengthOptions: number[]; minDays: number; maxDays: number }> }

/** Storage for products and their variants. The Postgres version below is the real one; tests use a fake. */
export interface ProductRepository {
  list(query: ProductListQuery): Promise<{ rows: ProductSummary[]; total: number }>
  findById(id: string): Promise<Product | null>
  /** Saves the product, its pictures, links and variants as one all-or-nothing step. Variants left out of `input` are switched off, never deleted. */
  create(input: ProductInput, adminId: string): Promise<Product>
  update(id: string, input: ProductInput, adminId: string): Promise<Product | null>
  setStatus(id: string, status: ProductStatus, adminId: string): Promise<Product | null>
  /** Marks (or unmarks) a product as not available on credit, without touching anything else. */
  setExcludedFromCredit(id: string, excluded: boolean, adminId: string): Promise<Product | null>
  nameExists(name: string, excludingId?: string): Promise<boolean>
  /** True when another product already uses this SKU. */
  skuTaken(sku: string, excludingId?: string): Promise<boolean>
  /** True when a variant of another product already uses one of these SKUs. */
  variantSkuTaken(skus: string[], excludingProductId?: string): Promise<boolean>
  categoryStatus(id: string): Promise<RecordStatus | null>
  /** A delivery area's status and coverage type, or null when there is no such area. */
  areaInfo(id: string): Promise<{ status: RecordStatus; coverageType: CoverageType } | null>
  /** How many subscriptions and trials of this product are running (active, or paused by a vacation) right now. */
  runningPlanCount(id: string): Promise<number>
  cutoffRuleStatus(id: string): Promise<RecordStatus | null>
  trialPlanStatuses(ids: string[]): Promise<Map<string, RecordStatus>>
  ruleStatuses(ids: string[]): Promise<Map<string, RecordStatus>>
  /** The ids, out of those given, of finished product pictures. */
  readyProductImages(ids: string[]): Promise<Set<string>>

  listPublic(query: PublicProductQuery): Promise<{ rows: PublicProduct[]; total: number }>
  findPublic(id: string): Promise<PublicProductDetail | null>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

const PRODUCT_COLUMNS = `p.id, p.name, p.name_gu, p.category_id, p.sku, p.short_description_en, p.short_description_gu, p.long_description_en, p.long_description_gu,
  p.nutrition_en, p.nutrition_gu, p.highlights_en, p.highlights_gu, p.badges, p.primary_image_asset_id, p.purchase_methods, p.delivery_method, p.service_area_id, p.cutoff_rule_id, p.include_in_production_planning, p.excluded_from_credit, p.status, p.updated_at, m.object_key as primary_key`
const PRODUCT_FROM = "products p left join media_assets m on m.id = p.primary_image_asset_id and m.status = 'ready'"
const VARIANT_COLUMNS = 'id, product_id, name, sku, price_paise, compare_at_price_paise, status, display_unit, display_quantity::float8 as display_quantity, production_unit, production_quantity::float8 as production_quantity'

const toVariant = (row: Row): ProductVariant => ({
  id: String(row.id), name: String(row.name), sku: String(row.sku), pricePaise: Number(row.price_paise), compareAtPricePaise: row.compare_at_price_paise === null ? null : Number(row.compare_at_price_paise),
  status: row.status as RecordStatus, displayUnit: String(row.display_unit), displayQuantity: Number(row.display_quantity), productionUnit: String(row.production_unit), productionQuantity: Number(row.production_quantity),
})

type Related = { variants: Map<string, ProductVariant[]>; gallery: Map<string, StoredImage[]>; trials: Map<string, string[]>; rules: Map<string, string[]> }
const push = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]) }

const toProduct = (row: Row, related: Related): Product => {
  const id = String(row.id)
  return {
    id, name: String(row.name), nameGu: String(row.name_gu), categoryId: String(row.category_id), sku: String(row.sku),
    shortDescriptionEn: String(row.short_description_en), shortDescriptionGu: String(row.short_description_gu), longDescriptionEn: String(row.long_description_en), longDescriptionGu: String(row.long_description_gu),
    nutritionEn: String(row.nutrition_en), nutritionGu: String(row.nutrition_gu), highlightsEn: strings(row.highlights_en), highlightsGu: strings(row.highlights_gu),
    badges: strings(row.badges) as Product['badges'], purchaseMethods: strings(row.purchase_methods) as PurchaseMethod[],
    deliveryMethod: (row.delivery_method as DeliveryMethod | null) ?? null, serviceAreaId: row.service_area_id ? String(row.service_area_id) : null, cutoffRuleId: row.cutoff_rule_id ? String(row.cutoff_rule_id) : null,
    includeInProductionPlanning: Boolean(row.include_in_production_planning), excludedFromCredit: Boolean(row.excluded_from_credit), trialPlanIds: related.trials.get(id) ?? [], subscriptionRuleIds: related.rules.get(id) ?? [],
    status: row.status as ProductStatus, updatedAt: iso(row.updated_at), variants: related.variants.get(id) ?? [],
    primaryImage: row.primary_image_asset_id && row.primary_key ? { assetId: String(row.primary_image_asset_id), key: String(row.primary_key) } : null, gallery: related.gallery.get(id) ?? [],
  }
}

/** Only what a product list shows. Built field by field so staff-only data (SKU, status, long text) can never slip into a public answer. */
const toPublicProduct = (product: Product, row: Row): PublicProduct => ({
  id: product.id, name: product.name, nameGu: product.nameGu, categoryId: product.categoryId, categoryName: String(row.category_name), categoryNameGu: String(row.category_name_gu),
  shortDescriptionEn: product.shortDescriptionEn, shortDescriptionGu: product.shortDescriptionGu, badges: product.badges, purchaseMethods: product.purchaseMethods,
  variants: product.variants, primaryImage: product.primaryImage,
})

export function createProductRepository(database: Database): ProductRepository {
  /** The variants, gallery and links of several products, each asked for once (never one query per product). */
  async function loadRelated(ids: string[], onlyActiveVariants = false): Promise<Related> {
    const [variants, gallery, trials, rules] = await Promise.all([
      database.query<Row>(`select ${VARIANT_COLUMNS} from product_variants where product_id = any($1::uuid[]) ${onlyActiveVariants ? "and status = 'active'" : ''} order by sort_order, created_at`, [ids]),
      database.query<Row>("select g.product_id, g.media_asset_id, m.object_key from product_gallery_images g join media_assets m on m.id = g.media_asset_id and m.status = 'ready' where g.product_id = any($1::uuid[]) order by g.position", [ids]),
      database.query<Row>('select product_id, trial_plan_id from product_trial_plans where product_id = any($1::uuid[])', [ids]),
      database.query<Row>('select product_id, subscription_rule_id from product_subscription_rules where product_id = any($1::uuid[])', [ids]),
    ])
    const related: Related = { variants: new Map(), gallery: new Map(), trials: new Map(), rules: new Map() }
    for (const row of variants.rows) push(related.variants, String(row.product_id), toVariant(row))
    for (const row of gallery.rows) push(related.gallery, String(row.product_id), { assetId: String(row.media_asset_id), key: String(row.object_key) })
    for (const row of trials.rows) push(related.trials, String(row.product_id), String(row.trial_plan_id))
    for (const row of rules.rows) push(related.rules, String(row.product_id), String(row.subscription_rule_id))
    return related
  }

  async function findById(id: string): Promise<Product | null> {
    const { rows } = await database.query<Row>(`select ${PRODUCT_COLUMNS} from ${PRODUCT_FROM} where p.id = $1`, [id])
    return rows[0] ? toProduct(rows[0], await loadRelated([id])) : null
  }

  const statuses = async (table: 'trial_plans' | 'subscription_rules', ids: string[]) => {
    const { rows } = await database.query<Row>(`select id, status from ${table} where id = any($1::uuid[])`, [ids])
    return new Map(rows.map(row => [String(row.id), row.status as RecordStatus]))
  }
  const statusOf = async (table: 'categories' | 'service_areas' | 'cutoff_rules', id: string): Promise<RecordStatus | null> => {
    const { rows } = await database.query<Row>(`select status from ${table} where id = $1`, [id])
    return rows[0] ? (rows[0].status as RecordStatus) : null
  }

  /** Writes everything about one product inside the caller's transaction and returns its id. */
  async function writeProduct(client: Pick<Database, 'query'>, id: string | null, input: ProductInput, adminId: string): Promise<string> {
    const fields = [input.name, input.nameGu, input.categoryId, input.sku, input.shortDescriptionEn, input.shortDescriptionGu, input.longDescriptionEn, input.longDescriptionGu, input.nutritionEn, input.nutritionGu,
      input.highlightsEn, input.highlightsGu, input.badges, input.primaryImageAssetId, input.purchaseMethods, input.deliveryMethod, input.serviceAreaId, input.cutoffRuleId, input.includeInProductionPlanning, input.status, adminId, input.excludedFromCredit]
    let productId: string
    if (id) {
      productId = id
      await client.query(
        `update products set name = $2, name_gu = $3, category_id = $4, sku = $5, short_description_en = $6, short_description_gu = $7, long_description_en = $8, long_description_gu = $9,
           nutrition_en = $10, nutrition_gu = $11, highlights_en = $12, highlights_gu = $13, badges = $14, primary_image_asset_id = $15, purchase_methods = $16, delivery_method = $17, service_area_id = $18,
           cutoff_rule_id = $19, include_in_production_planning = $20, status = $21, updated_by = $22, excluded_from_credit = $23, updated_at = now() where id = $1`,
        [id, ...fields],
      )
    } else {
      const { rows } = await client.query<Row>(
        `insert into products (name, name_gu, category_id, sku, short_description_en, short_description_gu, long_description_en, long_description_gu, nutrition_en, nutrition_gu,
           highlights_en, highlights_gu, badges, primary_image_asset_id, purchase_methods, delivery_method, service_area_id, cutoff_rule_id, include_in_production_planning, status, updated_by, excluded_from_credit)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) returning id`,
        fields,
      )
      productId = String((rows[0] as Row).id)
    }
    // The small link lists are replaced as a set.
    await client.query('delete from product_gallery_images where product_id = $1', [productId])
    if (input.galleryAssetIds.length > 0) {
      await client.query('insert into product_gallery_images (product_id, media_asset_id, position) select $1, a, p - 1 from unnest($2::uuid[]) with ordinality as t(a, p)', [productId, input.galleryAssetIds])
    }
    await client.query('delete from product_trial_plans where product_id = $1', [productId])
    if (input.trialPlanIds.length > 0) await client.query('insert into product_trial_plans (product_id, trial_plan_id) select $1, unnest($2::uuid[])', [productId, input.trialPlanIds])
    await client.query('delete from product_subscription_rules where product_id = $1', [productId])
    if (input.subscriptionRuleIds.length > 0) await client.query('insert into product_subscription_rules (product_id, subscription_rule_id) select $1, unnest($2::uuid[])', [productId, input.subscriptionRuleIds])

    // Variants are kept by id so old orders still point at them: edited in place, new ones added, left-out ones switched off.
    const keptIds: string[] = []
    for (const [index, variant] of input.variants.entries()) {
      const values = [variant.name, variant.sku, variant.pricePaise, variant.compareAtPricePaise, variant.status, variant.displayUnit, variant.displayQuantity, variant.productionUnit, variant.productionQuantity, index]
      if (variant.id) {
        await client.query(
          `update product_variants set name = $3, sku = $4, price_paise = $5, compare_at_price_paise = $6, status = $7, display_unit = $8, display_quantity = $9,
             production_unit = $10, production_quantity = $11, sort_order = $12, updated_at = now() where id = $1 and product_id = $2`,
          [variant.id, productId, ...values],
        )
        keptIds.push(variant.id)
      } else {
        const { rows } = await client.query<Row>(
          `insert into product_variants (product_id, name, sku, price_paise, compare_at_price_paise, status, display_unit, display_quantity, production_unit, production_quantity, sort_order)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [productId, ...values],
        )
        keptIds.push(String((rows[0] as Row).id))
      }
    }
    await client.query("update product_variants set status = 'inactive', updated_at = now() where product_id = $1 and status <> 'inactive' and id <> all($2::uuid[])", [productId, keptIds])
    return productId
  }

  return {
    async list({ search, status, categoryId, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select p.id, p.name, p.name_gu, p.category_id, c.name as category_name, p.sku, p.status, p.purchase_methods, p.delivery_method, p.excluded_from_credit, a.name as area_name, p.updated_at, m.object_key as primary_key,
           (select count(*)::int from product_variants v where v.product_id = p.id and v.status = 'active') as variant_count,
           (select min(v.price_paise) from product_variants v where v.product_id = p.id and v.status = 'active') as price_from,
           count(*) over() as total
         from products p join categories c on c.id = p.category_id left join service_areas a on a.id = p.service_area_id
           left join media_assets m on m.id = p.primary_image_asset_id and m.status = 'ready'
         where ($1::text is null or p.status = $1) and ($2::uuid is null or p.category_id = $2::uuid) and ($3::text is null or p.name ilike $3 or p.name_gu ilike $3 or p.sku ilike $3)
         order by p.name limit $4 offset $5`,
        [status ?? null, categoryId ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        rows: rows.map((row): ProductSummary => ({
          id: String(row.id), name: String(row.name), nameGu: String(row.name_gu), categoryId: String(row.category_id), categoryName: String(row.category_name), sku: String(row.sku), status: row.status as ProductStatus,
          purchaseMethods: strings(row.purchase_methods) as PurchaseMethod[], deliveryMethod: (row.delivery_method as DeliveryMethod | null) ?? null, serviceAreaName: row.area_name ? String(row.area_name) : null, excludedFromCredit: Boolean(row.excluded_from_credit), variantCount: Number(row.variant_count),
          priceFromPaise: row.price_from === null ? null : Number(row.price_from), primaryImageKey: row.primary_key ? String(row.primary_key) : null, updatedAt: iso(row.updated_at),
        })),
      }
    },
    findById,
    create: (input, adminId) => guardUnique(async () => {
      const id = await withTransaction(database, client => writeProduct(client, null, input, adminId))
      return (await findById(id)) as Product
    }),
    update: (id, input, adminId) => guardUnique(async () => {
      const found = await withTransaction(database, async client => {
        const { rows } = await client.query<Row>('select 1 from products where id = $1 for update', [id])
        if (!rows[0]) return false
        await writeProduct(client, id, input, adminId)
        return true
      })
      return found ? findById(id) : null
    }),
    async setStatus(id, status, adminId) {
      const { rows } = await database.query<Row>('update products set status = $2, updated_by = $3, updated_at = now() where id = $1 returning id', [id, status, adminId])
      return rows[0] ? findById(id) : null
    },
    async setExcludedFromCredit(id, excluded, adminId) {
      const { rows } = await database.query<Row>('update products set excluded_from_credit = $2, updated_by = $3, updated_at = now() where id = $1 returning id', [id, excluded, adminId])
      return rows[0] ? findById(id) : null
    },
    async nameExists(name, excludingId) {
      const { rows } = await database.query<Row>('select 1 from products where lower(trim(name)) = lower(trim($1)) and ($2::uuid is null or id <> $2::uuid) limit 1', [name, excludingId ?? null])
      return rows.length > 0
    },
    async skuTaken(sku, excludingId) {
      const { rows } = await database.query<Row>("select 1 from products where sku <> '' and lower(sku) = lower($1) and ($2::uuid is null or id <> $2::uuid) limit 1", [sku, excludingId ?? null])
      return rows.length > 0
    },
    async variantSkuTaken(skus, excludingProductId) {
      if (skus.length === 0) return false
      const { rows } = await database.query<Row>("select 1 from product_variants where sku <> '' and lower(sku) = any($1::text[]) and ($2::uuid is null or product_id <> $2::uuid) limit 1", [skus.map(sku => sku.toLowerCase()), excludingProductId ?? null])
      return rows.length > 0
    },
    categoryStatus: id => statusOf('categories', id),
    async areaInfo(id) {
      const { rows } = await database.query<Row>('select status, coverage_type from service_areas where id = $1', [id])
      return rows[0] ? { status: rows[0].status as RecordStatus, coverageType: rows[0].coverage_type as CoverageType } : null
    },
    async runningPlanCount(id) {
      const { rows } = await database.query<Row>("select count(*)::int as running from subscriptions where product_id = $1 and status = 'active'", [id])
      return Number(rows[0]?.running ?? 0)
    },
    cutoffRuleStatus: id => statusOf('cutoff_rules', id),
    trialPlanStatuses: ids => statuses('trial_plans', ids),
    ruleStatuses: ids => statuses('subscription_rules', ids),
    async readyProductImages(ids) {
      if (ids.length === 0) return new Set()
      const { rows } = await database.query<Row>("select id from media_assets where id = any($1::uuid[]) and purpose = 'product' and status = 'ready'", [ids])
      return new Set(rows.map(row => String(row.id)))
    },

    async listPublic({ category, search, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${PRODUCT_COLUMNS}, c.name as category_name, c.name_gu as category_name_gu, count(*) over() as total
         from ${PRODUCT_FROM} join categories c on c.id = p.category_id and c.status = 'active' join service_areas a on a.id = p.service_area_id and a.status = 'active'
         where p.status = 'active' and ($1::uuid is null or p.category_id = $1::uuid)
           and exists (select 1 from product_variants v where v.product_id = p.id and v.status = 'active')
           and ($2::text is null or p.name ilike $2 or p.name_gu ilike $2 or p.short_description_en ilike $2 or p.short_description_gu ilike $2)
         order by c.sort_order, c.name, p.name limit $3 offset $4`,
        [category ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      const related = await loadRelated(rows.map(row => String(row.id)), true)
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        rows: rows.map(row => toPublicProduct(toProduct(row, related), row)),
      }
    },
    async findPublic(id) {
      const { rows } = await database.query<Row>(
        `select ${PRODUCT_COLUMNS}, c.name as category_name, c.name_gu as category_name_gu
         from ${PRODUCT_FROM} join categories c on c.id = p.category_id and c.status = 'active' join service_areas a on a.id = p.service_area_id and a.status = 'active'
         where p.id = $1 and p.status = 'active'`,
        [id],
      )
      const row = rows[0]
      if (!row) return null
      const related = await loadRelated([id], true)
      const product = toProduct(row, related)
      if (product.variants.length === 0) return null
      const [trials, rules] = await Promise.all([
        database.query<Row>("select t.id, t.name, t.duration_days from product_trial_plans l join trial_plans t on t.id = l.trial_plan_id and t.status = 'active' where l.product_id = $1 order by t.duration_days", [id]),
        database.query<Row>("select r.id, r.name, r.system_type, r.length_options, r.min_days, r.max_days from product_subscription_rules l join subscription_rules r on r.id = l.subscription_rule_id and r.status = 'active' where l.product_id = $1 order by r.name", [id]),
      ])
      return {
        ...product, categoryName: String(row.category_name), categoryNameGu: String(row.category_name_gu),
        trialPlans: trials.rows.map(item => ({ id: String(item.id), name: String(item.name), durationDays: Number(item.duration_days) })),
        subscriptionRules: rules.rows.map(item => ({ id: String(item.id), name: String(item.name), systemType: String(item.system_type), lengthOptions: ((item.length_options as number[] | null) ?? []).map(Number), minDays: Number(item.min_days), maxDays: Number(item.max_days) })),
      }
    },
  }
}
