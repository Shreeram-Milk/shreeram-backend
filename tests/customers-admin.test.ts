import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'
import { signUpByEmail } from './checkout-helpers.js'

async function adminCookie(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}

/** A customer who signed up in the app, as the phone does it. Returns their token and id. */
async function signUp(api: TestApi, phone: string): Promise<{ token: string; id: string }> {
  const { token, customerId } = await signUpByEmail(api, phone)
  return { token, id: customerId }
}

const update = { name: 'Asha Patel', customerType: 'credit', adminNote: 'Pays on the 5th' }

describe('admin customers', () => {
  it('needs a signed-in admin, and a trusted origin to change anything', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/customers')).status).toBe(401)
    const cookie = await adminCookie(api)
    const { id } = await signUp(api, '9824612345')
    expect((await request(api.app).put(`/admin/customers/${id}`).set('Cookie', cookie).send(update)).status).toBe(403)
  })

  it('lists customers newest first, searches by name, phone or email, filters, and pages', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const get = (query: string) => request(api.app).get(`/admin/customers${query}`).set('Cookie', cookie)
    const first = await signUp(api, '9824612345')
    await signUp(api, '9876543210')
    await request(api.app).put(`/admin/customers/${first.id}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(update)
    expect((await get('')).body.total).toBe(2)
    expect((await get('?search=asha')).body.rows.map((row: { phone: string }) => row.phone)).toEqual(['+919824612345'])
    expect((await get('?search=98765')).body.rows).toHaveLength(1)
    expect((await get('?customerType=credit')).body.total).toBe(1)
    expect((await get('?pageSize=1&page=2')).body.rows).toHaveLength(1)
    expect((await get('?pageSize=1')).headers['cache-control']).toBe('no-store')
  })

  it('shows one customer, and a 404 for an unknown or malformed id', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const { id } = await signUp(api, '9824612345')
    expect((await request(api.app).get(`/admin/customers/${id}`).set('Cookie', cookie)).body.customer).toMatchObject({ id, phone: '+919824612345', customerType: 'prepaid', status: 'active' })
    expect((await request(api.app).get('/admin/customers/00000000-0000-4000-8000-000000000000').set('Cookie', cookie)).status).toBe(404)
    expect((await request(api.app).get('/admin/customers/nope').set('Cookie', cookie)).status).toBe(400)
  })

  it('saves details, writes an audit entry with field names only, and ignores fields staff may not change', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const { id } = await signUp(api, '9824612345')
    const response = await request(api.app).put(`/admin/customers/${id}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send({ ...update, email: 'someone@else.com', status: 'blocked', phone: '+910000000000', language: 'gu' })
    expect(response.body.customer).toMatchObject({ name: 'Asha Patel', email: 'c9824612345@example.com', customerType: 'credit', adminNote: 'Pays on the 5th', phone: '+919824612345', language: 'en', status: 'active' })
    const entry = api.audit.find(item => item.action === 'customer_updated')
    expect(entry?.details).toEqual({ customerId: id, fields: ['name', 'customerType', 'adminNote'] })
    expect(JSON.stringify(api.audit)).not.toContain('Asha')
  })

  it('refuses an unknown customer type', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const { id } = await signUp(api, '9824612345')
    expect((await request(api.app).put(`/admin/customers/${id}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send({ ...update, customerType: 'vip' })).status).toBe(400)
  })

  it('hides customers who deleted their account unless asked, and refuses to change them', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const { id, token } = await signUp(api, '9824612345')
    await request(api.app).delete('/customer/me').set('Authorization', `Bearer ${token}`)
    expect((await request(api.app).get('/admin/customers').set('Cookie', cookie)).body.total).toBe(0)
    expect((await request(api.app).get('/admin/customers?status=deleted').set('Cookie', cookie)).body.total).toBe(1)
    const response = await request(api.app).put(`/admin/customers/${id}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(update)
    expect(response.body.error.code).toBe('CUSTOMER_DELETED')
  })
})
