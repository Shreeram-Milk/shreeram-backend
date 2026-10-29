import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { buildRiderSheet, type RiderStopRow } from '../src/modules/production-planning/rider-sheet.js'
import { buildProductionPlan, type DemandRow } from '../src/modules/production-planning/rules.js'
import { planWarnings } from '../src/modules/production-planning/service.js'
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

  it('stays open before the delivery day when a window has no cut-off, shows windows in time order, and ignores sizes with no production figure in the totals', () => {
    const plan = buildProductionPlan('2026-10-15', [
      row({ slotId: 'evening', slotName: 'Evening', startTime: '17:00', endTime: '20:00' }),
      row({ variantId: 'noprod', variantName: 'Gift box', productionUnit: '', productionQuantity: 0 }),
    ], [{ slotId: 'morning', closesAt: null }], new Date('2026-10-14T10:00:00.000Z'))
    expect(plan.slots.map(slot => slot.slotName)).toEqual(['Morning', 'Evening'])
    expect(plan.slots[0]?.status).toBe('open')
    expect(plan.slots[0]?.production).toEqual([])
    expect(plan.slots[0]?.products[0]?.variants[0]?.production).toBeNull()
  })

  it('makes a window with no cut-off final once its delivery day has begun in India', () => {
    const rows = [row({})]
    const closings = [{ slotId: 'morning', closesAt: null }]
    // 2026-10-14 18:29 UTC is 23:59 on the 14th in India: still before the 15th. 18:30 UTC is midnight of the 15th.
    expect(buildProductionPlan('2026-10-15', rows, closings, new Date('2026-10-14T18:29:00.000Z')).slots[0]?.status).toBe('open')
    expect(buildProductionPlan('2026-10-15', rows, closings, new Date('2026-10-14T18:30:00.000Z')).slots[0]?.status).toBe('final')
  })

  it('gives an empty plan for a day with no orders', () => {
    expect(buildProductionPlan('2026-10-15', [], [], new Date())).toEqual({ date: '2026-10-15', slots: [], warnings: [] })
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

describe('plan warnings', () => {
  const now = new Date('2026-10-24T06:30:00.000Z')
  const fresh = { at: '2026-10-24T06:28:00.000Z', failures: 0 }
  it('says nothing when the subscription job is recent and the day is inside the horizon', () => {
    expect(planWarnings('2026-10-25', now, 3, fresh)).toEqual([])
  })
  it('warns that days beyond the horizon are missing subscriptions', () => {
    expect(planWarnings('2026-10-28', now, 3, fresh).map(warning => warning.code)).toEqual(['SUBSCRIPTIONS_NOT_READY'])
  })
  it('warns when the job never ran, ran long ago, or failed for some subscriptions', () => {
    expect(planWarnings('2026-10-25', now, 3, null).map(warning => warning.code)).toEqual(['SUBSCRIPTION_JOB_STALE'])
    expect(planWarnings('2026-10-25', now, 3, { at: '2026-10-24T05:00:00.000Z', failures: 0 }).map(warning => warning.code)).toEqual(['SUBSCRIPTION_JOB_STALE'])
    expect(planWarnings('2026-10-25', now, 3, { ...fresh, failures: 2 }).map(warning => warning.code)).toEqual(['SUBSCRIPTION_JOB_FAILING'])
  })
})

const stop = (extra: Partial<RiderStopRow>): RiderStopRow => ({
  orderId: 'o', orderNumber: 'SR-1', recipientName: 'Patel', recipientPhone: '9825000000', addressLine1: 'B-2', addressLine2: 'Shyam Flats', landmark: '', city: 'Ahmedabad',
  pinCode: '380015', doorstepNote: '', kind: 'subscription', items: [{ productId: 'cow', variantId: 'half', productName: 'Cow Milk', variantName: '500 ml', quantity: 1 }], ...extra,
})
const morning = { slotId: '00000000-0000-4000-8000-000000000001', name: 'Morning', startTime: '06:00', endTime: '08:00' }

describe('rider sheet', () => {
  const sheet = (stops: RiderStopRow[], now = '2026-10-14T16:00:00.000Z') =>
    buildRiderSheet({ date: '2026-10-15', slot: morning, stops, closing: { slotId: morning.slotId, closesAt: '2026-10-14T15:30:00.000Z' }, truncated: false, warnings: [], now: new Date(now) })

  it('puts each PIN code together, lowest first, so a rider never goes back to an area', () => {
    const result = sheet([stop({ orderId: 'a', pinCode: '380054' }), stop({ orderId: 'b', pinCode: '380015' }), stop({ orderId: 'c', pinCode: '380054', addressLine1: 'B-3' }), stop({ orderId: 'd', pinCode: '380015', addressLine1: 'B-3' })])
    expect(result.areas.map(area => [area.pinCode, area.stops.map(item => item.orderId)])).toEqual([['380015', ['b', 'd']], ['380054', ['a', 'c']]])
    expect(result.stopCount).toBe(4)
  })

  it('keeps one society together and counts flat numbers in order, whatever the case and spacing customers typed', () => {
    const result = sheet([
      stop({ orderId: 'b10', addressLine1: 'B-10', addressLine2: 'Shyam Flats' }),
      stop({ orderId: 'ram', addressLine1: '4', addressLine2: 'Ramdev Society' }),
      stop({ orderId: 'b2', addressLine1: 'B-2', addressLine2: 'shyam  flats ' }),
    ])
    expect(result.areas[0]?.stops.map(item => item.orderId)).toEqual(['ram', 'b2', 'b10'])
  })

  it('adds up every product and size to load, per area and for the whole sheet', () => {
    const buffalo = { productId: 'buf', variantId: 'half', productName: 'Buffalo Milk', variantName: '500 ml', quantity: 2 }
    const litre = { productId: 'cow', variantId: 'litre', productName: 'Cow Milk', variantName: '1 L', quantity: 1 }
    const result = sheet([
      stop({ orderId: 'a', items: [{ ...litre }, { ...buffalo }] }),
      stop({ orderId: 'b', recipientName: 'Shah' }),
      stop({ orderId: 'c', pinCode: '380054', items: [{ ...buffalo, quantity: 3 }] }),
    ])
    expect(result.areas[0]?.load.map(line => [line.productName, line.variantName, line.quantity])).toEqual([['Buffalo Milk', '500 ml', 2], ['Cow Milk', '1 L', 1], ['Cow Milk', '500 ml', 1]])
    expect(result.load.map(line => [line.productName, line.variantName, line.quantity])).toEqual([['Buffalo Milk', '500 ml', 5], ['Cow Milk', '1 L', 1], ['Cow Milk', '500 ml', 1]])
  })

  it('makes one stop of several orders for the same house, adding up the same product, and keeps another address separate', () => {
    const ghee = { productId: 'ghee', variantId: 'jar', productName: 'Ghee', variantName: '500 ml', quantity: 1 }
    const result = sheet([
      stop({ orderId: 'first', kind: 'one_time', items: [{ productId: 'cow', variantId: 'half', productName: 'Cow Milk', variantName: '500 ml', quantity: 5 }] }),
      stop({ orderId: 'second', recipientName: ' patel ', kind: 'trial', items: [{ productId: 'cow', variantId: 'half', productName: 'Cow Milk', variantName: '500 ml', quantity: 1 }, { ...ghee }] }),
      stop({ orderId: 'elsewhere', addressLine1: 'C-7' }),
    ])
    const stops = result.areas[0]?.stops ?? []
    expect(stops.map(item => item.orderId)).toEqual(['first', 'elsewhere'])
    expect(stops[0]?.items.map(item => [item.productName, item.quantity])).toEqual([['Cow Milk', 6], ['Ghee', 1]])
    expect(stops[0]?.kind).toBe('trial')
    expect(result.stopCount).toBe(2)
    expect(result.load.map(line => [line.productName, line.quantity])).toEqual([['Cow Milk', 7], ['Ghee', 1]])
  })

  it('is open until the window closes and final from then on, like production planning', () => {
    expect(sheet([stop({})], '2026-10-14T15:29:00.000Z').status).toBe('open')
    expect(sheet([stop({})], '2026-10-14T15:30:00.000Z').status).toBe('final')
  })
})

describe('GET /admin/production-planning/rider-sheet', () => {
  it('needs a signed-in admin, a date and a window, and says when the window does not exist', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get(`/admin/production-planning/rider-sheet?date=2026-10-15&slotId=${morning.slotId}`).set('Origin', ADMIN_ORIGIN)).status).toBe(401)
    await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
    const verified = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
    const cookie = ((verified.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
    const get = (query: string) => request(api.app).get(`/admin/production-planning/rider-sheet${query}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN)
    expect((await get('?date=2026-10-15')).status).toBe(400)
    expect((await get('?date=2026-10-15&slotId=morning')).status).toBe(400)
    const missing = await get(`?date=2026-10-15&slotId=${morning.slotId}`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('SLOT_NOT_FOUND')
    api.riderStops.slot = morning
    api.riderStops.stops.push(stop({}))
    const response = await get(`?date=2026-10-15&slotId=${morning.slotId}`)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.sheet).toMatchObject({ slot: { name: 'Morning' }, stopCount: 1, areas: [{ pinCode: '380015' }] })
  })
})
