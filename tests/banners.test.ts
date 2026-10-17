import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { businessDate } from '../src/modules/banners/service.js'
import { ADMIN_ORIGIN, PASSWORD, createClock, createTestApi, type TestApi } from './fakes.js'

const valid = { titleEn: 'Fresh milk today', messageEn: 'Delivered before 7 AM', sortOrder: 1 }

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const admin = (api: TestApi, cookie: string) => ({
  get: (path: string) => request(api.app).get(path).set('Cookie', cookie),
  send: (method: 'post' | 'put' | 'patch', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body),
})

describe('admin banners', () => {
  it('needs a signed-in admin for every action', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/banners')).status).toBe(401)
    expect((await request(api.app).post('/admin/banners').set('Origin', ADMIN_ORIGIN).send(valid)).status).toBe(401)
    expect((await request(api.app).patch('/admin/banners/6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f/status').set('Origin', ADMIN_ORIGIN).send({ status: 'inactive' })).status).toBe(401)
  })
  it('refuses to change anything when the request does not come from the admin site', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const response = await request(api.app).post('/admin/banners').set('Cookie', cookie).set('Origin', 'https://evil.example').send(valid)
    expect([response.status, response.body.error.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED'])
    expect(api.banners.rows).toHaveLength(0)
  })
  it('creates, lists, updates and switches a banner, with defaults filled in and an audit entry each time', async () => {
    const api = await createTestApi()
    const call = admin(api, await signedIn(api))
    const created = await call.send('post', '/admin/banners', valid)
    expect(created.status).toBe(201)
    expect(created.body.banner).toMatchObject({ titleEn: 'Fresh milk today', type: 'promotion', audience: 'all_users', ctaType: 'none', ctaTarget: '', status: 'active', startDate: null, endDate: null })
    const id = created.body.banner.id as string
    expect((await call.get('/admin/banners')).body.banners).toHaveLength(1)
    const updated = await call.send('put', `/admin/banners/${id}`, { ...valid, titleEn: 'New headline', ctaType: 'category', ctaTarget: 'category-milk' })
    expect(updated.body.banner).toMatchObject({ titleEn: 'New headline', ctaType: 'category', ctaTarget: 'category-milk' })
    expect((await call.send('patch', `/admin/banners/${id}/status`, { status: 'inactive' })).body.banner.status).toBe('inactive')
    expect(api.audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['banner_created', 'banner_updated', 'banner_status_changed']))
  })
  it('rejects bad input with the fields at fault, and unknown extras are dropped', async () => {
    const api = await createTestApi()
    const call = admin(api, await signedIn(api))
    const bad = await call.send('post', '/admin/banners', { titleEn: '   ', ctaType: 'product', startDate: '2026-02-30', endDate: '2026-01-01', sortOrder: -1, status: 'deleted' })
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['sortOrder', 'startDate', 'status', 'titleEn'])
    const ok = await call.send('post', '/admin/banners', { ...valid, id: 'attacker-chosen', createdAt: '1999-01-01', isAdmin: true })
    expect(ok.status).toBe(201)
    expect(ok.body.banner.id).not.toBe('attacker-chosen')
    expect(ok.body.banner.isAdmin).toBeUndefined()
  })
  it('enforces the link and date rules together', async () => {
    const api = await createTestApi()
    const call = admin(api, await signedIn(api))
    expect((await call.send('post', '/admin/banners', { ...valid, ctaType: 'none', ctaTarget: 'x' })).status).toBe(400)
    expect((await call.send('post', '/admin/banners', { ...valid, startDate: '2026-10-12', endDate: '2026-10-10' })).status).toBe(400)
    expect((await call.send('post', '/admin/banners', { ...valid, startDate: '2026-10-10', endDate: '2026-10-10' })).status).toBe(201)
  })
  it('fetches one banner by id, and answers an unknown id with 404 and a malformed id with 400', async () => {
    const api = await createTestApi()
    const call = admin(api, await signedIn(api))
    const created = (await call.send('post', '/admin/banners', valid)).body.banner as { id: string }
    const found = await call.get(`/admin/banners/${created.id}`)
    expect([found.status, found.body.banner.id, found.body.banner.titleEn]).toEqual([200, created.id, 'Fresh milk today'])
    expect((await call.get('/admin/banners/6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f')).body.error.code).toBe('BANNER_NOT_FOUND')
    expect((await call.get('/admin/banners/not-a-uuid')).body.error.code).toBe('VALIDATION_ERROR')
    expect((await request(api.app).get(`/admin/banners/${created.id}`)).status).toBe(401)
  })
  it('answers an unknown banner with 404 and a malformed id with 400', async () => {
    const api = await createTestApi()
    const call = admin(api, await signedIn(api))
    expect((await call.send('put', '/admin/banners/6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f', valid)).body.error.code).toBe('BANNER_NOT_FOUND')
    expect((await call.send('patch', '/admin/banners/not-a-uuid/status', { status: 'active' })).body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('public banners (what the app reads)', () => {
  it('shows only active banners inside their dates, for everyone, in order, with nothing private', async () => {
    const clock = createClock('2026-10-10T06:00:00.000Z')
    const api = await createTestApi({ clock })
    const call = admin(api, await signedIn(api))
    const add = (body: object) => call.send('post', '/admin/banners', { ...valid, ...body })
    await add({ titleEn: 'Second', sortOrder: 2 })
    await add({ titleEn: 'First', sortOrder: 1 })
    await add({ titleEn: 'Inactive', status: 'inactive' })
    await add({ titleEn: 'Starts later', startDate: '2026-10-11' })
    await add({ titleEn: 'Already over', endDate: '2026-10-09' })
    await add({ titleEn: 'Only credit customers', audience: 'credit' })
    const response = await request(api.app).get('/public/banners')
    expect(response.status).toBe(200)
    expect(response.body.banners.map((banner: { titleEn: string }) => banner.titleEn)).toEqual(['First', 'Second'])
    expect(Object.keys(response.body.banners[0]).sort()).toEqual(['ctaTarget', 'ctaType', 'id', 'imageUrl', 'labelEn', 'labelGu', 'messageEn', 'messageGu', 'sortOrder', 'titleEn', 'titleGu', 'type'])
    clock.set('2026-10-11T06:00:00.000Z')
    expect((await request(api.app).get('/public/banners')).body.banners.map((banner: { titleEn: string }) => banner.titleEn)).toEqual(['First', 'Starts later', 'Second'])
  })
  it('needs no sign-in', async () => {
    const api = await createTestApi({ withAdmin: false })
    expect((await request(api.app).get('/public/banners')).status).toBe(200)
  })
  it('uses the date in India, not the server’s: 00:30 on the 10th in India is still the 9th in UTC', () => {
    expect(businessDate(new Date('2026-10-09T19:00:00.000Z'))).toBe('2026-10-10')
    expect(businessDate(new Date('2026-10-09T18:00:00.000Z'))).toBe('2026-10-09')
  })
})
