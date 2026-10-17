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

const area = (extra: object = {}) => ({ name: 'Gandhinagar local', coverageType: 'pin_code', state: 'Gujarat', city: 'Gandhinagar', ...extra })

async function setup(api: TestApi) {
  const cookie = await signedIn(api)
  const morning = (await send(api, cookie, 'post', '/admin/delivery-slots', { name: 'Morning', startTime: '05:00', endTime: '07:00' })).body.slot.id as string
  const evening = (await send(api, cookie, 'post', '/admin/delivery-slots', { name: 'Evening', startTime: '17:00', endTime: '19:00' })).body.slot.id as string
  const areaId = (await send(api, cookie, 'post', '/admin/service-areas', area())).body.area.id as string
  return { cookie, morning, evening, areaId }
}
const pin = (slots: string[], extra: object = {}) => ({ pinCode: '382010', locality: 'Sector 10', allowedDeliverySlotIds: slots, ...extra })

describe('service areas (admin)', () => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/service-areas')).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post('/admin/service-areas').set('Cookie', cookie).set('Origin', 'https://evil.example').send(area())
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
  })

  it('asks for the place each kind of area needs, and clears what the kind does not use', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const noPlace = await send(api, cookie, 'post', '/admin/service-areas', { name: 'A', coverageType: 'pin_code' })
    expect(noPlace.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['city', 'state'])
    expect((await send(api, cookie, 'post', '/admin/service-areas', { name: 'B', coverageType: 'state' })).body.error.details[0].field).toBe('state')
    const gujarat = await send(api, cookie, 'post', '/admin/service-areas', { name: 'Gujarat', coverageType: 'state', state: 'Gujarat', city: 'Ahmedabad' })
    expect(gujarat.body.area).toMatchObject({ coverageType: 'state', state: 'Gujarat', city: '', pinCount: 0 })
    const india = await send(api, cookie, 'post', '/admin/service-areas', { name: 'Pan India', coverageType: 'pan_india', state: 'Gujarat', city: 'Surat' })
    expect(india.body.area).toMatchObject({ state: '', city: '' })
    expect((await send(api, cookie, 'post', '/admin/service-areas', { name: 'C', coverageType: 'moon', state: 'x' })).status).toBe(400)
  })

  it('refuses a repeated name, edits an area and audits the changes', async () => {
    const api = await createTestApi()
    const { cookie, areaId } = await setup(api)
    const again = await send(api, cookie, 'post', '/admin/service-areas', area({ name: ' GANDHINAGAR local ' }))
    expect([again.status, again.body.error.code]).toEqual([409, 'NAME_TAKEN'])
    expect((await send(api, cookie, 'put', `/admin/service-areas/${areaId}`, area({ description: 'Sectors 1 to 30' }))).body.area.description).toBe('Sectors 1 to 30')
    expect(api.audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['service_area_created', 'service_area_updated']))
    expect((await get(api, cookie, '/admin/service-areas/6f1c2d3e-0000-4000-8000-000000000000')).body.error.code).toBe('SERVICE_AREA_NOT_FOUND')
  })

  it('adds, searches, filters and edits PIN codes, each with its allowed slots', async () => {
    const api = await createTestApi()
    const { cookie, morning, evening, areaId } = await setup(api)
    const base = `/admin/service-areas/${areaId}/pins`
    const first = await send(api, cookie, 'post', base, pin([morning, evening, morning]))
    expect(first.status).toBe(201)
    expect(first.body.pin.allowedDeliverySlotIds).toEqual([morning, evening])
    await send(api, cookie, 'post', base, pin([evening], { pinCode: '382011', locality: 'Sector 11' }))
    await send(api, cookie, 'post', base, pin([morning], { pinCode: '382012', locality: 'Sector 12', status: 'inactive' }))

    const all = await get(api, cookie, base)
    expect(all.body.total).toBe(3)
    expect(all.body.rows.map((row: { pinCode: string }) => row.pinCode)).toEqual(['382010', '382011', '382012'])
    expect((await get(api, cookie, `${base}?search=sector%2011`)).body.rows).toHaveLength(1)
    expect((await get(api, cookie, `${base}?slotId=${morning}`)).body.total).toBe(2)
    expect((await get(api, cookie, `${base}?status=inactive`)).body.rows[0].pinCode).toBe('382012')
    expect((await get(api, cookie, `${base}?pageSize=2&page=2`)).body.rows).toHaveLength(1)
    expect((await get(api, cookie, '/admin/service-areas')).body.rows[0]).toMatchObject({ pinCount: 3 })

    const edited = await send(api, cookie, 'put', `${base}/${first.body.pin.id}`, pin([evening], { locality: 'Sector 10A' }))
    expect(edited.body.pin).toMatchObject({ locality: 'Sector 10A', allowedDeliverySlotIds: [evening] })
    expect(api.audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['service_area_pin_created', 'service_area_pin_updated']))
  })

  it('refuses a bad PIN, a repeated PIN, no slots, unknown slots and PINs in a non-PIN area', async () => {
    const api = await createTestApi()
    const { cookie, morning, areaId } = await setup(api)
    const base = `/admin/service-areas/${areaId}/pins`
    const bad = await send(api, cookie, 'post', base, { pinCode: '012345', allowedDeliverySlotIds: [] })
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['allowedDeliverySlotIds', 'pinCode'])
    expect((await send(api, cookie, 'post', base, pin([morning]))).status).toBe(201)
    const again = await send(api, cookie, 'post', base, pin([morning]))
    expect([again.status, again.body.error.code]).toEqual([409, 'PIN_EXISTS'])
    const unknown = await send(api, cookie, 'post', base, pin(['6f1c2d3e-0000-4000-8000-000000000000'], { pinCode: '382020' }))
    expect([unknown.status, unknown.body.error.details[0].field]).toEqual([400, 'allowedDeliverySlotIds'])
    const stateId = (await send(api, cookie, 'post', '/admin/service-areas', { name: 'Gujarat', coverageType: 'state', state: 'Gujarat' })).body.area.id as string
    const wrongKind = await send(api, cookie, 'post', `/admin/service-areas/${stateId}/pins`, pin([morning]))
    expect([wrongKind.status, wrongKind.body.error.code]).toEqual([409, 'AREA_NOT_PIN_BASED'])
  })

  it('does not let a PIN newly allow an inactive slot, but lets it keep one it already had', async () => {
    const api = await createTestApi()
    const { cookie, morning, evening, areaId } = await setup(api)
    const base = `/admin/service-areas/${areaId}/pins`
    const id = (await send(api, cookie, 'post', base, pin([morning, evening]))).body.pin.id as string
    await send(api, cookie, 'patch', `/admin/delivery-slots/${evening}/status`, { status: 'inactive' })
    expect((await send(api, cookie, 'put', `${base}/${id}`, pin([morning, evening], { locality: 'Renamed' }))).status).toBe(200)
    const another = await send(api, cookie, 'post', base, pin([evening], { pinCode: '382030' }))
    expect([another.status, another.body.error.details[0].message]).toEqual([400, 'Choose an active slot.'])
  })

  it('adds many PIN codes at once, skipping ones the area already has and repeats in the list', async () => {
    const api = await createTestApi()
    const { cookie, morning, areaId } = await setup(api)
    const base = `/admin/service-areas/${areaId}/pins`
    await send(api, cookie, 'post', base, pin([morning]))
    const bulk = await send(api, cookie, 'post', `${base}/bulk`, { pinCodes: ['382010', '382011', '382011', '382012'], allowedDeliverySlotIds: [morning], locality: 'Gandhinagar' })
    expect(bulk.status).toBe(201)
    expect(bulk.body).toEqual({ added: ['382011', '382012'], skipped: ['382010'] })
    expect((await get(api, cookie, base)).body.total).toBe(3)
    const tooMany = await send(api, cookie, 'post', `${base}/bulk`, { pinCodes: Array.from({ length: 501 }, (_, index) => String(100_000 + index)), allowedDeliverySlotIds: [morning] })
    expect(tooMany.status).toBe(400)
    const oneBad = await send(api, cookie, 'post', `${base}/bulk`, { pinCodes: ['382013', '38201'], allowedDeliverySlotIds: [morning] })
    expect(oneBad.status).toBe(400)
    expect((await get(api, cookie, base)).body.total).toBe(3)
  })

  it('gives each pasted PIN its own locality when one is sent, and the shared locality to the rest', async () => {
    const api = await createTestApi()
    const { cookie, morning, areaId } = await setup(api)
    const base = `/admin/service-areas/${areaId}/pins`
    const bulk = await send(api, cookie, 'post', `${base}/bulk`, { pinCodes: ['382010', '382011', '382012'], locality: 'Gandhinagar', localities: { '382010': 'Sector 10', '382011': 'Sector 11, Sector 11 Colony' }, allowedDeliverySlotIds: [morning] })
    expect(bulk.body.added).toEqual(['382010', '382011', '382012'])
    const rows = (await get(api, cookie, base)).body.rows as Array<{ pinCode: string; locality: string }>
    expect(rows.map(row => [row.pinCode, row.locality])).toEqual([['382010', 'Sector 10'], ['382011', 'Sector 11, Sector 11 Colony'], ['382012', 'Gandhinagar']])
    const badKey = await send(api, cookie, 'post', `${base}/bulk`, { pinCodes: ['382013'], localities: { 'abc': 'x' }, allowedDeliverySlotIds: [morning] })
    expect(badKey.status).toBe(400)
  })

  it('asks before removing PIN codes when the kind changes, and refuses if delivery cards need the old kind', async () => {
    const api = await createTestApi()
    const { cookie, morning, areaId } = await setup(api)
    await send(api, cookie, 'post', `/admin/service-areas/${areaId}/pins`, pin([morning]))
    const toState = area({ coverageType: 'state' })

    api.serviceAreas.brokenProducts.set(areaId, ['state'])
    const refused = await send(api, cookie, 'put', `/admin/service-areas/${areaId}`, toState)
    expect([refused.status, refused.body.error.code]).toEqual([409, 'AREA_COVERAGE_IN_USE'])
    api.serviceAreas.brokenProducts.clear()

    const unconfirmed = await send(api, cookie, 'put', `/admin/service-areas/${areaId}`, toState)
    expect([unconfirmed.status, unconfirmed.body.error.code, unconfirmed.body.error.details]).toEqual([409, 'PIN_REMOVAL_NEEDS_CONFIRMATION', { pinCount: 1 }])
    expect(api.serviceAreas.pins.get(areaId)).toHaveLength(1)

    const confirmed = await send(api, cookie, 'put', `/admin/service-areas/${areaId}`, { ...toState, confirmRemovePins: true })
    expect(confirmed.body.area).toMatchObject({ coverageType: 'state', pinCount: 0, city: '' })
    expect(api.serviceAreas.pins.get(areaId)).toBeUndefined()
  })

  it('asks for a confirmation before switching off an area that delivery cards use', async () => {
    const api = await createTestApi()
    const { cookie, areaId } = await setup(api)
    api.serviceAreas.productsByArea.set(areaId, ['Gandhinagar milk'])
    const blocked = await send(api, cookie, 'patch', `/admin/service-areas/${areaId}/status`, { status: 'inactive' })
    expect([blocked.status, blocked.body.error.code, blocked.body.error.details[0].examples]).toEqual([409, 'IN_USE', ['Gandhinagar milk']])
    expect((await send(api, cookie, 'put', `/admin/service-areas/${areaId}`, area({ status: 'inactive' }))).body.error.code).toBe('IN_USE')
    expect((await send(api, cookie, 'patch', `/admin/service-areas/${areaId}/status`, { status: 'inactive', confirmInUse: true })).body.area.status).toBe('inactive')
  })
})
