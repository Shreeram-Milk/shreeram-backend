import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const send = (api: TestApi, cookie: string, method: 'post' | 'put' | 'patch', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)

/** The three plain lists behave the same way; each case says what is special about its fields. */
const cases = [
  { path: '/admin/categories', key: 'category', valid: { name: 'Milk', nameGu: 'દૂધ', sortOrder: 1 }, other: { name: 'Curd' }, invalid: { name: ' ', nameGu: 'x'.repeat(41), sortOrder: -1 }, invalidFields: ['name', 'nameGu', 'sortOrder'], store: (api: TestApi) => api.categories, defaults: { description: '', status: 'active' } },
  { path: '/admin/trial-plans', key: 'trialPlan', valid: { name: '3-day trial', durationDays: 3 }, other: { name: '7-day trial', durationDays: 7 }, invalid: { name: ' ', durationDays: 0 }, invalidFields: ['durationDays', 'name'], store: (api: TestApi) => api.trialPlans, defaults: { description: '', status: 'active' } },
  { path: '/admin/subscription-rules', key: 'subscriptionRule', valid: { name: 'Daily', systemType: 'daily' }, other: { name: 'Alternate days', systemType: 'alternate_days' }, invalid: { name: ' ', systemType: 'monthly' }, invalidFields: ['name', 'systemType'], store: (api: TestApi) => api.subscriptionRules, defaults: { description: '', status: 'active' } },
]

describe.each(cases)('$path (admin)', ({ path, key, valid, other, invalid, invalidFields, store, defaults }) => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get(path)).status).toBe(401)
    expect((await request(api.app).post(path).set('Origin', ADMIN_ORIGIN).send(valid)).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post(path).set('Cookie', cookie).set('Origin', 'https://evil.example').send(valid)
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(store(api).rows).toHaveLength(0)
  })

  it('creates, reads, edits and lists records, filling defaults and auditing each change', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const created = await send(api, cookie, 'post', path, valid)
    expect(created.status).toBe(201)
    expect(created.body[key]).toMatchObject({ ...valid, ...defaults })
    const id = created.body[key].id as string
    await send(api, cookie, 'post', path, other)
    expect((await request(api.app).get(`${path}/${id}`).set('Cookie', cookie)).body[key].name).toBe(valid.name)
    expect((await send(api, cookie, 'put', `${path}/${id}`, { ...valid, description: 'Edited' })).body[key].description).toBe('Edited')
    expect((await request(api.app).get(`${path}/all`).set('Cookie', cookie)).body.rows).toHaveLength(2)
    expect((await request(api.app).get(`${path}?search=${encodeURIComponent(other.name.slice(0, 3))}`).set('Cookie', cookie)).body.total).toBe(1)
    expect(api.audit.map(entry => entry.action).filter(action => action.endsWith('_created') || action.endsWith('_updated'))).toHaveLength(3)
  })

  it('refuses bad input naming the field, and drops unknown fields', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const bad = await send(api, cookie, 'post', path, invalid)
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(invalidFields)
    const ok = await send(api, cookie, 'post', path, { ...valid, id: 'chosen-by-attacker', updatedBy: 'someone' })
    expect(ok.body[key].id).not.toBe('chosen-by-attacker')
    expect((await request(api.app).get(`${path}/not-an-id`).set('Cookie', cookie)).status).toBe(400)
    expect((await request(api.app).get(`${path}/6f1c2d3e-0000-4000-8000-000000000000`).set('Cookie', cookie)).status).toBe(404)
  })

  it('refuses a repeated name, ignoring case and spaces, but lets a record keep its own name', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const first = await send(api, cookie, 'post', path, valid)
    const again = await send(api, cookie, 'post', path, { ...valid, name: `  ${valid.name.toUpperCase()} ` })
    expect([again.status, again.body.error.code]).toEqual([409, 'NAME_TAKEN'])
    expect((await send(api, cookie, 'put', `${path}/${first.body[key].id}`, { ...valid, description: 'Same name' })).status).toBe(200)
  })

  it('asks for a confirmation before switching off a record that products use', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const id = (await send(api, cookie, 'post', path, valid)).body[key].id as string
    store(api).productsByRecord.set(id, 3)
    const blocked = await send(api, cookie, 'patch', `${path}/${id}/status`, { status: 'inactive' })
    expect([blocked.status, blocked.body.error.code, blocked.body.error.details[0].count]).toEqual([409, 'IN_USE', 3])
    expect((await send(api, cookie, 'put', `${path}/${id}`, { ...valid, status: 'inactive' })).body.error.code).toBe('IN_USE')
    expect(store(api).rows[0]?.status).toBe('active')
    expect((await send(api, cookie, 'patch', `${path}/${id}/status`, { status: 'inactive', confirmInUse: true })).body[key].status).toBe('inactive')
    expect((await send(api, cookie, 'patch', `${path}/${id}/status`, { status: 'active' })).body[key].status).toBe('active')
  })
})
