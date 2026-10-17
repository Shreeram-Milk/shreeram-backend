import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}

type Case = { path: string; audit: string; rows: (api: TestApi) => Array<{ id: string }>; markUsed: (api: TestApi, id: string) => void }
const cases: Case[] = [
  { path: '/admin/categories', audit: 'category_deleted', rows: api => api.categories.rows, markUsed: (api, id) => api.categories.productsByRecord.set(id, 2) },
  { path: '/admin/trial-plans', audit: 'trial_plan_deleted', rows: api => api.trialPlans.rows, markUsed: (api, id) => api.trialPlans.productsByRecord.set(id, 2) },
  { path: '/admin/subscription-rules', audit: 'subscription_rule_deleted', rows: api => api.subscriptionRules.rows, markUsed: (api, id) => api.subscriptionRules.productsByRecord.set(id, 2) },
  { path: '/admin/delivery-slots', audit: 'delivery_slot_deleted', rows: api => api.deliverySlots.rows, markUsed: (api, id) => api.deliverySlots.usageBySlot.set(id, { areas: 1, rules: 0 }) },
  { path: '/admin/cutoff-rules', audit: 'cutoff_rule_deleted', rows: api => api.cutoffRules.rows, markUsed: (api, id) => api.cutoffRules.productsByRule.set(id, ['Gandhinagar milk']) },
  { path: '/admin/service-areas', audit: 'service_area_deleted', rows: api => api.serviceAreas.rows, markUsed: (api, id) => api.serviceAreas.productsByArea.set(id, ['Gandhinagar milk']) },
]

describe.each(cases)('deleting from $path', ({ path, audit, rows, markUsed }) => {
  const seed = (api: TestApi) => { const id = randomUUID(); rows(api).push({ id, name: 'Seeded', status: 'active' } as { id: string }); return id }
  const remove = (api: TestApi, cookie: string, id: string) => request(api.app).delete(`${path}/${id}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN)

  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    const id = seed(api)
    expect((await request(api.app).delete(`${path}/${id}`).set('Origin', ADMIN_ORIGIN)).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).delete(`${path}/${id}`).set('Cookie', cookie).set('Origin', 'https://evil.example')
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(rows(api)).toHaveLength(1)
  })

  it('deletes a record nothing uses and records who did it', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const id = seed(api)
    expect((await remove(api, cookie, id)).status).toBe(204)
    expect(rows(api)).toHaveLength(0)
    expect(api.audit.find(entry => entry.action === audit)?.details).toMatchObject(expect.any(Object))
    expect((await remove(api, cookie, id)).status).toBe(404)
  })

  it('refuses to delete a record that is used and keeps it', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const id = seed(api)
    markUsed(api, id)
    const blocked = await remove(api, cookie, id)
    expect([blocked.status, blocked.body.error.code]).toEqual([409, 'IN_USE'])
    expect(blocked.body.error.details.length).toBeGreaterThan(0)
    expect(rows(api)).toHaveLength(1)
    expect(api.audit.some(entry => entry.action === audit)).toBe(false)
  })

  it('rejects an id that is not a UUID', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await remove(api, cookie, 'not-an-id')).status).toBe(400)
  })
})
