import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { buildProductionPlan, type DemandRow } from '../src/modules/production-planning/rules.js'
import { ADMIN_ORIGIN, PASSWORD, createTestApi } from './fakes.js'

const row = (extra: Partial<DemandRow>): DemandRow => ({
  slotId: 'morning', slotName: 'Morning', startTime: '05:00', endTime: '07:00', productId: 'milk', productName: 'Cow Milk', variantId: 'half', variantName: '500 ml',
  quantity: 40, orderCount: 12, productionUnit: 'Litre', productionQuantity: 20, ...extra,
})

describe('how much to make', () => {
  const closings = [{ slotId: 'morning', closesAt: '2026-10-14T15:30:00.000Z' }, { slotId: 'evening', closesAt: '2026-10-15T05:30:00.000Z' }]

  it('adds up each product and window in its production unit, and the total per window', () => {
    const plan = buildProductionPlan('2026-10-15', [
      row({}),
      row({ variantId: 'litre', variantName: '1 L', quantity: 10, orderCount: 5, productionQuantity: 10 }),
      row({ productId: 'curd', productName: 'Curd', variantId: 'cup', variantName: '400 g', quantity: 6, orderCount: 3, productionUnit: 'Kg', productionQuantity: 2.4 }),
    ], closings, new Date('2026-10-14T10:00:00.000Z'))
    expect(plan.slots).toHaveLength(1)
    const [morning] = plan.slots
    expect(morning?.production).toEqual([{ unit: 'Kg', quantity: 2.4 }, { unit: 'Litre', quantity: 30 }])
    const milk = morning?.products.find(product => product.productId === 'milk')
    expect(milk?.variants.map(variant => [variant.variantName, variant.quantity, variant.orderCount])).toEqual([['500 ml', 40, 12], ['1 L', 10, 5]])
    expect(milk?.production).toEqual([{ unit: 'Litre', quantity: 30 }])
  })

  it('splits every amount into one-time, trial and subscription, and counts what was cancelled or skipped', () => {
    const plan = buildProductionPlan('2026-10-15', [
      row({ quantity: 20, byType: { oneTime: 10, trial: 5, subscription: 5 }, cancelledQuantity: 2 }),
      row({ variantId: 'litre', variantName: '1 L', quantity: 4, productionQuantity: 4, byType: { oneTime: 0, trial: 0, subscription: 4 }, cancelledQuantity: 1 }),
    ], closings, new Date('2026-10-14T10:00:00.000Z'))
    const [morning] = plan.slots
    expect(morning).toMatchObject({ quantity: 24, byType: { oneTime: 10, trial: 5, subscription: 9 }, cancelledQuantity: 3 })
    expect(morning?.products[0]).toMatchObject({ quantity: 24, byType: { oneTime: 10, trial: 5, subscription: 9 }, cancelledQuantity: 3 })
    expect(morning?.products[0]?.variants[0]).toMatchObject({ byType: { oneTime: 10, trial: 5, subscription: 5 }, cancelledQuantity: 2 })
    const counted = buildProductionPlan('2026-10-15', [row({})], [{ slotId: 'morning', closesAt: null, orderCount: 7 }], new Date('2026-10-14T10:00:00.000Z'))
    expect(counted.slots[0]?.orderCount).toBe(7)
  })

  it('is open until the window order-by time and final from then on', () => {
    const rows = [row({}), row({ slotId: 'evening', slotName: 'Evening', startTime: '17:00', endTime: '20:00' })]
    const before = buildProductionPlan('2026-10-15', rows, closings, new Date('2026-10-14T15:29:00.000Z'))
    expect(before.slots.map(slot => [slot.slotName, slot.status])).toEqual([['Morning', 'open'], ['Evening', 'open']])
    const after = buildProductionPlan('2026-10-15', rows, closings, new Date('2026-10-14T15:30:00.000Z'))
    expect(after.slots.map(slot => [slot.slotName, slot.status])).toEqual([['Morning', 'final'], ['Evening', 'open']])
  })

  it('stays open when a window has no cut-off, shows windows in time order, and ignores sizes with no production figure in the totals', () => {
    const plan = buildProductionPlan('2026-10-15', [
      row({ slotId: 'evening', slotName: 'Evening', startTime: '17:00', endTime: '20:00' }),
      row({ variantId: 'noprod', variantName: 'Gift box', productionUnit: '', productionQuantity: 0 }),
    ], [{ slotId: 'morning', closesAt: null }], new Date('2026-12-01T00:00:00.000Z'))
    expect(plan.slots.map(slot => slot.slotName)).toEqual(['Morning', 'Evening'])
    expect(plan.slots[0]?.status).toBe('open')
    expect(plan.slots[0]?.production).toEqual([])
    expect(plan.slots[0]?.products[0]?.variants[0]?.production).toBeNull()
  })

  it('gives an empty plan for a day with no orders', () => {
    expect(buildProductionPlan('2026-10-15', [], [], new Date())).toEqual({ date: '2026-10-15', slots: [] })
  })
})

describe('GET /admin/production-planning', () => {
  it('needs a signed-in admin, checks the date, and returns the plan', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/production-planning?date=2026-10-15').set('Origin', ADMIN_ORIGIN)).status).toBe(401)
    await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
    const verified = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
    const cookie = ((verified.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
    const get = (query: string) => request(api.app).get(`/admin/production-planning${query}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN)
    expect((await get('')).status).toBe(400)
    expect((await get('?date=2026-13-45')).status).toBe(400)
    api.productionDemand.rows.push(row({}))
    api.productionDemand.closings.push({ slotId: 'morning', closesAt: '2026-10-14T15:30:00.000Z' })
    const response = await get('?date=2026-10-15')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.plan.slots[0]).toMatchObject({ slotName: 'Morning', production: [{ unit: 'Litre', quantity: 20 }] })
  })
})
