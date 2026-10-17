import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'
import { signUpByEmail } from './checkout-helpers.js'

async function adminCookie(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}

async function signUp(api: TestApi, phone: string): Promise<{ token: string; id: string }> {
  const { token, customerId } = await signUpByEmail(api, phone)
  return { token, id: customerId }
}

const address = { label: 'home', recipientName: 'Asha Patel', recipientPhone: '9824612345', line1: 'B-12, Sunrise Society', line2: 'Sector 7', landmark: '', city: 'Gandhinagar', pinCode: '382010' }

describe('admin view of a customer\'s addresses', () => {
  it('needs a signed-in admin', async () => {
    const api = await createTestApi()
    const { id } = await signUp(api, '9824612345')
    expect((await request(api.app).get(`/admin/customers/${id}/addresses`)).status).toBe(401)
  })

  it('shows the saved addresses and delivery notes, read-only, and never caches them', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const { id, token } = await signUp(api, '9824612345')
    await request(api.app).post('/customer/addresses').set('Authorization', `Bearer ${token}`).send(address)
    await request(api.app).put('/customer/doorstep-instructions').set('Authorization', `Bearer ${token}`).send({ dropLocation: 'milk-box', handoff: 'leave-at-door', noDoorbell: true, noCall: false, notifyAfterDelivery: true, additionalInstructions: 'Dog in the garden' })
    const response = await request(api.app).get(`/admin/customers/${id}/addresses`).set('Cookie', cookie)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.addresses).toMatchObject([{ label: 'home', recipientName: 'Asha Patel', pinCode: '382010', isDefault: true }])
    expect(response.body.instructions).toMatchObject({ dropLocation: 'milk-box', noDoorbell: true, additionalInstructions: 'Dog in the garden' })
    const write = await request(api.app).put(`/admin/customers/${id}/addresses`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(address)
    expect(write.status).toBe(404)
  })

  it('answers 404 for an unknown customer and 400 for a malformed id', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    expect((await request(api.app).get('/admin/customers/00000000-0000-4000-8000-000000000000/addresses').set('Cookie', cookie)).status).toBe(404)
    expect((await request(api.app).get('/admin/customers/nope/addresses').set('Cookie', cookie)).status).toBe(400)
  })
})
