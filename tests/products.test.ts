import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const send = (api: TestApi, cookie: string, method: 'post' | 'put' | 'patch', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
const get = (api: TestApi, cookie: string, path: string) => request(api.app).get(path).set('Cookie', cookie)

/** Everything a product points at: a category, a delivery area, a trial plan, a subscription rule and two finished pictures. */
async function setup(api: TestApi) {
  const cookie = await signedIn(api)
  const category = (await send(api, cookie, 'post', '/admin/categories', { name: 'Milk', nameGu: 'દૂધ', sortOrder: 1 })).body.category.id as string
  const slot = (await send(api, cookie, 'post', '/admin/delivery-slots', { name: 'Morning', startTime: '05:00', endTime: '07:00' })).body.slot.id as string
  const area = (await send(api, cookie, 'post', '/admin/service-areas', { name: 'Gandhinagar', coverageType: 'pin_code', state: 'Gujarat', city: 'Gandhinagar' })).body.area.id as string
  await send(api, cookie, 'post', `/admin/service-areas/${area}/pins`, { pinCode: '382010', allowedDeliverySlotIds: [slot] })
  const trial = (await send(api, cookie, 'post', '/admin/trial-plans', { name: '3-day trial', durationDays: 3 })).body.trialPlan.id as string
  const rule = (await send(api, cookie, 'post', '/admin/subscription-rules', { name: 'Daily', systemType: 'daily' })).body.subscriptionRule.id as string
  const picture = () => { const id = randomUUID(); api.media.rows.push({ id, objectKey: `products/2026/10/${id}.webp`, purpose: 'product', contentType: 'image/webp', sizeBytes: 1000, status: 'ready' }); return id }
  return { cookie, category, area, trial, rule, picture }
}
type Ids = Awaited<ReturnType<typeof setup>>

const variant = (extra: object = {}) => ({ name: '500 ml', pricePaise: 3500, displayUnit: 'ml', displayQuantity: 500, productionUnit: 'Litre', productionQuantity: 0.5, ...extra })
const draft = (ids: Ids, extra: object = {}) => ({ name: 'Cow Milk', categoryId: ids.category, ...extra })
const live = (ids: Ids, extra: object = {}) => draft(ids, {
  status: 'active', purchaseMethods: ['buy_once', 'trial'], trialPlanIds: [ids.trial], deliveryMethod: 'local_delivery', serviceAreaId: ids.area, variants: [variant(), variant({ name: '1 L', pricePaise: 7000, displayQuantity: 1, displayUnit: 'L', productionQuantity: 1 })], ...extra,
})

describe('products (admin)', () => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/products')).status).toBe(401)
    const ids = await setup(api)
    const foreign = await request(api.app).post('/admin/products').set('Cookie', ids.cookie).set('Origin', 'https://evil.example').send(draft(ids))
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(api.products.rows).toHaveLength(0)
  })

  it('saves a half-finished draft with defaults filled in, and a complete live product with its variants', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const saved = await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { highlightsEn: [' Fresh ', 'fresh', '', 'No preservatives'], badges: ['seasonal', 'seasonal'] }))
    expect(saved.status).toBe(201)
    expect(saved.body.product).toMatchObject({ name: 'Cow Milk', status: 'draft', sku: '', purchaseMethods: [], deliveryMethod: null, serviceAreaId: null, cutoffRuleId: null, includeInProductionPlanning: false, variants: [], highlightsEn: ['Fresh', 'fresh', 'No preservatives'], badges: ['seasonal'] })
    const published = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { name: 'Buffalo Milk' }))
    expect(published.status).toBe(201)
    expect(published.body.product.variants.map((item: { name: string; id: string }) => [item.name, typeof item.id])).toEqual([['500 ml', 'string'], ['1 L', 'string']])
    expect(api.audit.map(entry => entry.action)).toContain('product_created')
  })

  it('names the fields that stop a live product, and drops unknown fields', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const bare = await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { status: 'active', purchaseMethods: ['trial', 'subscription'] }))
    expect([bare.status, bare.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(bare.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['deliveryMethod', 'serviceAreaId', 'subscriptionRuleIds', 'trialPlanIds', 'variants'])
    const bad = await send(api, ids.cookie, 'post', '/admin/products', { name: ' ', categoryId: 'nope', variants: [variant({ pricePaise: -1 }), variant({ compareAtPricePaise: 100 }), variant({ name: ' 500 ML ' })] })
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field)).toEqual(expect.arrayContaining(['name', 'categoryId', 'variants.0.pricePaise', 'variants.1.compareAtPricePaise', 'variants']))
    const ok = await send(api, ids.cookie, 'post', '/admin/products', { ...draft(ids), id: 'chosen-by-attacker', updatedBy: 'someone' })
    expect(ok.body.product.id).not.toBe('chosen-by-attacker')
  })

  it('checks the category, delivery area, plans and rules exist, and are active when newly chosen', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const ghost = '6f1c2d3e-0000-4000-8000-000000000000'
    const missing = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { categoryId: ghost, serviceAreaId: ghost, trialPlanIds: [ghost] }))
    expect(missing.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['categoryId', 'serviceAreaId', 'trialPlanIds'])
    await send(api, ids.cookie, 'patch', `/admin/categories/${ids.category}/status`, { status: 'inactive' })
    const inactive = await send(api, ids.cookie, 'post', '/admin/products', draft(ids))
    expect([inactive.status, inactive.body.error.details[0].message]).toEqual([400, 'Choose an active category.'])
  })

  it('keeps a product\'s own links when they were switched off later, and drops links that do not apply', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const id = (await send(api, ids.cookie, 'post', '/admin/products', live(ids))).body.product.id as string
    await send(api, ids.cookie, 'patch', `/admin/trial-plans/${ids.trial}/status`, { status: 'inactive', confirmInUse: true })
    const same = await send(api, ids.cookie, 'put', `/admin/products/${id}`, live(ids, { shortDescriptionEn: 'Edited' }))
    expect(same.status).toBe(200)
    expect(same.body.product.trialPlanIds).toEqual([ids.trial])
    const noTrial = await send(api, ids.cookie, 'put', `/admin/products/${id}`, live(ids, { purchaseMethods: ['buy_once'], trialPlanIds: [ids.trial] }))
    expect(noTrial.body.product.trialPlanIds).toEqual([])
  })

  it('refuses a repeated product name or SKU, including a variant SKU used elsewhere', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { sku: 'MILK-1', variants: [variant({ sku: 'V-500' })] }))
    const sameName = await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: '  COW milk ' }))
    expect([sameName.status, sameName.body.error.code]).toEqual([409, 'NAME_TAKEN'])
    const sameSku = await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: 'Other', sku: 'milk-1' }))
    expect([sameSku.status, sameSku.body.error.code]).toEqual([409, 'SKU_TAKEN'])
    const sameVariantSku = await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: 'Another', variants: [variant({ sku: 'v-500' })] }))
    expect([sameVariantSku.status, sameVariantSku.body.error.code]).toEqual([409, 'SKU_TAKEN'])
  })

  it('accepts only finished product pictures, keeps the main picture out of the gallery and limits the gallery', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const main = ids.picture()
    const extra = ids.picture()
    const ok = await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { primaryImageAssetId: main, galleryAssetIds: [main, extra, extra] }))
    expect(ok.status).toBe(201)
    expect(ok.body.product.primaryImage).toMatchObject({ assetId: main, url: expect.stringContaining('files.test/products/') })
    expect(ok.body.product.gallery.map((image: { assetId: string }) => image.assetId)).toEqual([extra])
    expect(JSON.stringify(ok.body)).not.toContain('"key"')
    const pending = randomUUID()
    api.media.rows.push({ id: pending, objectKey: 'products/x.webp', purpose: 'product', contentType: 'image/webp', sizeBytes: 10, status: 'pending' })
    const banner = randomUUID()
    api.media.rows.push({ id: banner, objectKey: 'banners/x.webp', purpose: 'banner', contentType: 'image/webp', sizeBytes: 10, status: 'ready' })
    expect((await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: 'A', primaryImageAssetId: pending }))).body.error.details[0].field).toBe('primaryImageAssetId')
    expect((await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: 'B', galleryAssetIds: [banner] }))).body.error.details[0].field).toBe('galleryAssetIds')
    const eleven = Array.from({ length: 11 }, () => ids.picture())
    expect((await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: 'C', galleryAssetIds: eleven }))).status).toBe(400)
  })

  it('edits variants in place, switches left-out ones off instead of deleting, and refuses variants of another product', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const created = (await send(api, ids.cookie, 'post', '/admin/products', live(ids))).body.product
    const [half, litre] = created.variants as Array<{ id: string }>
    const edited = await send(api, ids.cookie, 'put', `/admin/products/${created.id}`, live(ids, { variants: [{ ...variant({ pricePaise: 3600 }), id: half?.id }, variant({ name: '2 L', pricePaise: 14000, displayQuantity: 2, displayUnit: 'L' })] }))
    const byName = new Map((edited.body.product.variants as Array<{ id: string; name: string; status: string; pricePaise: number }>).map(item => [item.name, item]))
    expect(byName.get('500 ml')).toMatchObject({ id: half?.id, pricePaise: 3600, status: 'active' })
    expect(byName.get('1 L')).toMatchObject({ id: litre?.id, status: 'inactive' })
    expect(byName.get('2 L')?.status).toBe('active')
    const other = (await send(api, ids.cookie, 'post', '/admin/products', live(ids, { name: 'Other milk' }))).body.product
    const stolen = await send(api, ids.cookie, 'put', `/admin/products/${created.id}`, live(ids, { variants: [{ ...variant(), id: other.variants[0].id }] }))
    expect([stolen.status, stolen.body.error.details[0].field]).toEqual([400, 'variants.0.id'])
    const reuse = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { name: 'Third', variants: [{ ...variant(), id: half?.id }] }))
    expect(reuse.status).toBe(400)
  })

  it('lets a product start as a draft, but never go back to one once it has been published', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const id = (await send(api, ids.cookie, 'post', '/admin/products', live(ids))).body.product.id as string
    const back = await send(api, ids.cookie, 'put', `/admin/products/${id}`, live(ids, { status: 'draft' }))
    expect([back.status, back.body.error.code]).toEqual([409, 'PRODUCT_CANNOT_RETURN_TO_DRAFT'])
    expect((await send(api, ids.cookie, 'put', `/admin/products/${id}`, live(ids, { status: 'inactive' }))).body.product.status).toBe('inactive')
  })

  it('switches a product on only when it is complete, and off at any time', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const id = (await send(api, ids.cookie, 'post', '/admin/products', draft(ids))).body.product.id as string
    const early = await send(api, ids.cookie, 'patch', `/admin/products/${id}/status`, { status: 'active' })
    expect([early.status, early.body.error.code]).toEqual([409, 'PRODUCT_NOT_READY'])
    await send(api, ids.cookie, 'put', `/admin/products/${id}`, live(ids, { status: 'draft' }))
    expect((await send(api, ids.cookie, 'patch', `/admin/products/${id}/status`, { status: 'active' })).body.product.status).toBe('active')
    expect((await send(api, ids.cookie, 'patch', `/admin/products/${id}/status`, { status: 'inactive' })).body.product.status).toBe('inactive')
    expect((await send(api, ids.cookie, 'patch', `/admin/products/${id}/status`, { status: 'draft' })).status).toBe(400)
  })

  it('lists with search, status and category filters and a lowest price', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    await send(api, ids.cookie, 'post', '/admin/products', live(ids))
    await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: 'Ghee draft' }))
    const all = await get(api, ids.cookie, '/admin/products')
    expect(all.body.total).toBe(2)
    expect(all.body.rows.find((row: { name: string }) => row.name === 'Cow Milk')).toMatchObject({ priceFromPaise: 3500, variantCount: 2, categoryName: 'Milk', deliveryMethod: 'local_delivery', serviceAreaName: 'Gandhinagar' })
    expect((await get(api, ids.cookie, '/admin/products?status=draft')).body.rows.map((row: { name: string }) => row.name)).toEqual(['Ghee draft'])
    expect((await get(api, ids.cookie, '/admin/products?search=cow')).body.total).toBe(1)
    expect((await get(api, ids.cookie, `/admin/products?categoryId=${ids.category}`)).body.total).toBe(2)
    expect((await get(api, ids.cookie, '/admin/products/6f1c2d3e-0000-4000-8000-000000000000')).body.error.code).toBe('PRODUCT_NOT_FOUND')
  })
})

describe('the customer catalogue (public)', () => {
  it('shows only live products with their active variants and nothing staff-only', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const main = ids.picture()
    const id = (await send(api, ids.cookie, 'post', '/admin/products', live(ids, { sku: 'SECRET-SKU', primaryImageAssetId: main, shortDescriptionEn: 'Fresh milk' }))).body.product.id as string
    await send(api, ids.cookie, 'post', '/admin/products', draft(ids, { name: 'Unfinished' }))
    const list = await request(api.app).get('/public/products')
    expect(list.status).toBe(200)
    expect(list.headers['cache-control']).toContain('public')
    expect(list.body.products).toHaveLength(1)
    expect(list.body.products[0]).toMatchObject({ id, name: 'Cow Milk', categoryName: 'Milk', priceFromPaise: 3500, imageUrl: expect.stringContaining('files.test/') })
    expect(JSON.stringify(list.body)).not.toMatch(/SECRET-SKU|"status"|"sku"|objectKey|"key"/)
    // Switching a variant off hides it; switching all off hides the product.
    await send(api, ids.cookie, 'put', `/admin/products/${id}`, live(ids, { variants: [variant()] }))
    expect((await request(api.app).get('/public/products')).body.products[0].variants).toHaveLength(1)
    await send(api, ids.cookie, 'patch', `/admin/products/${id}/status`, { status: 'inactive' })
    expect((await request(api.app).get('/public/products')).body.products).toEqual([])
  })

  it('hides products whose category or delivery area is switched off, and filters by category and search', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const other = (await send(api, ids.cookie, 'post', '/admin/categories', { name: 'Ghee' })).body.category.id as string
    await send(api, ids.cookie, 'post', '/admin/products', live(ids))
    await send(api, ids.cookie, 'post', '/admin/products', live(ids, { name: 'Cow Ghee', categoryId: other }))
    expect((await request(api.app).get(`/public/products?category=${other}`)).body.products.map((item: { name: string }) => item.name)).toEqual(['Cow Ghee'])
    expect((await request(api.app).get('/public/products?search=ghee')).body.total).toBe(1)
    await send(api, ids.cookie, 'patch', `/admin/categories/${other}/status`, { status: 'inactive', confirmInUse: true })
    expect((await request(api.app).get('/public/products')).body.products.map((item: { name: string }) => item.name)).toEqual(['Cow Milk'])
    await send(api, ids.cookie, 'patch', `/admin/service-areas/${ids.area}/status`, { status: 'inactive', confirmInUse: true })
    expect((await request(api.app).get('/public/products')).body.products).toEqual([])
  })

  it('gives the product page its text, gallery and the active plans and rules on offer', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const gallery = ids.picture()
    const id = (await send(api, ids.cookie, 'post', '/admin/products', live(ids, { longDescriptionEn: 'Milked at dawn.', highlightsEn: ['Before 7 AM'], galleryAssetIds: [gallery], purchaseMethods: ['buy_once', 'trial', 'subscription'], subscriptionRuleIds: [ids.rule] }))).body.product.id as string
    const page = await request(api.app).get(`/public/products/${id}`)
    expect(page.body.product).toMatchObject({ longDescriptionEn: 'Milked at dawn.', highlightsEn: ['Before 7 AM'], trialPlans: [{ name: '3-day trial', durationDays: 3 }], subscriptionRules: [{ name: 'Daily', systemType: 'daily' }] })
    expect(page.body.product.galleryUrls).toHaveLength(1)
    expect((await request(api.app).get('/public/products/6f1c2d3e-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await request(api.app).get('/public/products/not-an-id')).status).toBe(400)
  })

  it('lists active categories for the shelves, in order', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    await send(api, ids.cookie, 'post', '/admin/categories', { name: 'Curd', sortOrder: 2 })
    const hidden = (await send(api, ids.cookie, 'post', '/admin/categories', { name: 'Old', sortOrder: 0 })).body.category.id as string
    await send(api, ids.cookie, 'patch', `/admin/categories/${hidden}/status`, { status: 'inactive' })
    const response = await request(api.app).get('/public/categories')
    expect(response.body.categories.map((item: { name: string }) => item.name)).toEqual(['Milk', 'Curd'])
    expect(Object.keys(response.body.categories[0]).sort()).toEqual(['description', 'id', 'name', 'nameGu', 'sortOrder'])
  })
})

describe('courier products', () => {
  it('can only be bought once: a trial or subscription on a courier product is refused', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const category = (await send(api, cookie, 'post', '/admin/categories', { name: 'Ghee' })).body.category.id as string
    const india = (await send(api, cookie, 'post', '/admin/service-areas', { name: 'All India', coverageType: 'pan_india', state: '', city: '' })).body.area.id as string
    const trial = (await send(api, cookie, 'post', '/admin/trial-plans', { name: '3-day trial', durationDays: 3 })).body.trialPlan.id as string
    const product = { name: 'Cow Ghee', categoryId: category, status: 'active', deliveryMethod: 'shipping', serviceAreaId: india, variants: [{ name: '250 g', pricePaise: 22000, displayUnit: 'g', displayQuantity: 250, productionUnit: 'kg', productionQuantity: 0.25 }] }
    const refused = await send(api, cookie, 'post', '/admin/products', { ...product, purchaseMethods: ['buy_once', 'trial'], trialPlanIds: [trial] })
    expect([refused.status, refused.body.error.details.map((issue: { field: string }) => issue.field)]).toEqual([400, ['purchaseMethods']])
    expect((await send(api, cookie, 'post', '/admin/products', { ...product, purchaseMethods: ['buy_once'] })).status).toBe(201)
  })
})

describe('how a product is delivered', () => {
  const state = (api: TestApi, ids: Ids) => send(api, ids.cookie, 'post', '/admin/service-areas', { name: 'All Gujarat', coverageType: 'state', state: 'Gujarat' }).then(response => response.body.area.id as string)
  const cutoff = async (api: TestApi, ids: Ids) => {
    const slots = await get(api, ids.cookie, '/admin/delivery-slots/all')
    return (await send(api, ids.cookie, 'post', '/admin/cutoff-rules', { name: 'Order by 9 PM', conditions: [{ deliverySlotId: slots.body.rows[0].id, dayRelation: 'previous_day', cutoffTime: '21:00' }] })).body.rule.id as string
  }

  it('saves the delivery method, area, cut-off rule and production choice on the product', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const rule = await cutoff(api, ids)
    const saved = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { cutoffRuleId: rule, includeInProductionPlanning: true }))
    expect(saved.body.product).toMatchObject({ deliveryMethod: 'local_delivery', serviceAreaId: ids.area, cutoffRuleId: rule, includeInProductionPlanning: true })
  })

  it('keeps delivery method and area matched, and shipping simple', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const rule = await cutoff(api, ids)
    const wholeState = await state(api, ids)
    const localInState = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { serviceAreaId: wholeState }))
    expect(localInState.body.error.details).toEqual([{ field: 'serviceAreaId', message: 'Local delivery needs a delivery area made of PIN codes.' }])
    const shipToPins = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { deliveryMethod: 'shipping', purchaseMethods: ['buy_once'], trialPlanIds: [] }))
    expect(shipToPins.body.error.details[0]).toMatchObject({ field: 'serviceAreaId' })
    const shippingWithCutoff = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { deliveryMethod: 'shipping', purchaseMethods: ['buy_once'], trialPlanIds: [], serviceAreaId: wholeState, cutoffRuleId: rule }))
    expect(shippingWithCutoff.body.error.details[0]).toMatchObject({ field: 'deliveryMethod' })
    const shipping = await send(api, ids.cookie, 'post', '/admin/products', live(ids, { deliveryMethod: 'shipping', purchaseMethods: ['buy_once'], trialPlanIds: [], serviceAreaId: wholeState }))
    expect(shipping.status).toBe(201)
  })

  it('cannot go live without a delivery method and area, and cannot be switched on if the area is off', async () => {
    const api = await createTestApi()
    const ids = await setup(api)
    const id = (await send(api, ids.cookie, 'post', '/admin/products', live(ids, { status: 'draft' }))).body.product.id as string
    await send(api, ids.cookie, 'patch', `/admin/service-areas/${ids.area}/status`, { status: 'inactive', confirmInUse: true })
    const blocked = await send(api, ids.cookie, 'patch', `/admin/products/${id}/status`, { status: 'active' })
    expect([blocked.status, blocked.body.error.code]).toEqual([409, 'PRODUCT_NOT_READY'])
  })
})
