import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const send = (api: TestApi, cookie: string, method: 'post' | 'put' | 'patch', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
const slot = (extra: object = {}) => ({ name: 'Morning', startTime: '05:00', endTime: '07:00', ...extra })

describe('delivery slots (admin)', () => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/delivery-slots')).status).toBe(401)
    expect((await request(api.app).post('/admin/delivery-slots').set('Origin', ADMIN_ORIGIN).send(slot())).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post('/admin/delivery-slots').set('Cookie', cookie).set('Origin', 'https://evil.example').send(slot())
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(api.deliverySlots.rows).toHaveLength(0)
  })

  it('creates, reads, edits and lists slots in time order, with an audit entry each time', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const evening = await send(api, cookie, 'post', '/admin/delivery-slots', slot({ name: 'Evening', startTime: '17:00', endTime: '19:00' }))
    const morning = await send(api, cookie, 'post', '/admin/delivery-slots', slot({ description: 'Before work' }))
    expect(morning.status).toBe(201)
    expect(morning.body.slot).toMatchObject({ name: 'Morning', description: 'Before work', status: 'active', startTime: '05:00', endTime: '07:00' })
    expect((await request(api.app).get('/admin/delivery-slots/all').set('Cookie', cookie)).body.rows.map((row: { name: string }) => row.name)).toEqual(['Morning', 'Evening'])
    const id = morning.body.slot.id as string
    expect((await send(api, cookie, 'put', `/admin/delivery-slots/${id}`, slot({ endTime: '07:30' }))).body.slot.endTime).toBe('07:30')
    expect((await request(api.app).get(`/admin/delivery-slots/${evening.body.slot.id}`).set('Cookie', cookie)).body.slot.name).toBe('Evening')
    expect(api.audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['delivery_slot_created', 'delivery_slot_updated']))
  })

  it('refuses bad input naming the field, an end before the start, and drops unknown fields', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const bad = await send(api, cookie, 'post', '/admin/delivery-slots', { name: ' ', startTime: '25:00', endTime: '9am', status: 'deleted' })
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['endTime', 'name', 'startTime', 'status'])
    const backwards = await send(api, cookie, 'post', '/admin/delivery-slots', slot({ startTime: '09:00', endTime: '09:00' }))
    expect([backwards.status, backwards.body.error.details[0].field]).toEqual([400, 'endTime'])
    const ok = await send(api, cookie, 'post', '/admin/delivery-slots', { ...slot(), id: 'chosen-by-attacker' })
    expect(ok.body.slot.id).not.toBe('chosen-by-attacker')
    expect((await request(api.app).get('/admin/delivery-slots/not-an-id').set('Cookie', cookie)).status).toBe(400)
    expect((await request(api.app).get('/admin/delivery-slots/6f1c2d3e-0000-4000-8000-000000000000').set('Cookie', cookie)).body.error.code).toBe('DELIVERY_SLOT_NOT_FOUND')
  })

  it('refuses a name that is already used, ignoring case and spaces, but lets a slot keep its own name', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const first = await send(api, cookie, 'post', '/admin/delivery-slots', slot())
    const again = await send(api, cookie, 'post', '/admin/delivery-slots', slot({ name: '  MORNING ', startTime: '08:00', endTime: '09:00' }))
    expect([again.status, again.body.error.code]).toEqual([409, 'NAME_TAKEN'])
    expect((await send(api, cookie, 'put', `/admin/delivery-slots/${first.body.slot.id}`, slot({ description: 'Same name, new note' }))).status).toBe(200)
  })

  it('switches an unused slot off straight away, and an in-use one only after the admin confirms', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const unused = (await send(api, cookie, 'post', '/admin/delivery-slots', slot())).body.slot.id as string
    expect((await send(api, cookie, 'patch', `/admin/delivery-slots/${unused}/status`, { status: 'inactive' })).body.slot.status).toBe('inactive')

    const used = (await send(api, cookie, 'post', '/admin/delivery-slots', slot({ name: 'Evening', startTime: '17:00', endTime: '19:00' }))).body.slot.id as string
    api.deliverySlots.usageBySlot.set(used, { areas: 2, rules: 1 })
    const usage = await request(api.app).get(`/admin/delivery-slots/${used}/usage`).set('Cookie', cookie)
    expect(usage.body.usage.map((item: { label: string; count: number }) => [item.label, item.count])).toEqual([['service areas', 2], ['cut-off rules', 1]])

    const blocked = await send(api, cookie, 'patch', `/admin/delivery-slots/${used}/status`, { status: 'inactive' })
    expect([blocked.status, blocked.body.error.code]).toEqual([409, 'IN_USE'])
    expect(api.deliverySlots.rows.find(row => row.id === used)?.status).toBe('active')
    // Saving the whole form with "inactive" cannot sneak around the same check.
    const viaForm = await send(api, cookie, 'put', `/admin/delivery-slots/${used}`, slot({ name: 'Evening', startTime: '17:00', endTime: '19:00', status: 'inactive' }))
    expect([viaForm.status, viaForm.body.error.code]).toEqual([409, 'IN_USE'])

    const confirmed = await send(api, cookie, 'patch', `/admin/delivery-slots/${used}/status`, { status: 'inactive', confirmInUse: true })
    expect(confirmed.body.slot.status).toBe('inactive')
    expect(api.audit.find(entry => entry.action === 'delivery_slot_status_changed' && entry.details?.forced === true)).toBeTruthy()
    // Switching back on never needs a confirmation.
    expect((await send(api, cookie, 'patch', `/admin/delivery-slots/${used}/status`, { status: 'active' })).body.slot.status).toBe('active')
  })
})
