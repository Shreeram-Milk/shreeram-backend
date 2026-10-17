import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { normalizePhone } from '../src/modules/customer-auth/schema.js'
import { MAX_CODES_PER_EMAIL_PER_HOUR } from '../src/modules/customer-auth/service.js'
import { createFakeCustomerAuthRepository, createTestApi, SECRET, type TestApi } from './fakes.js'
import { createCustomerAuthService } from '../src/modules/customer-auth/service.js'

const PHONE = '+919824612345'
const EMAIL = 'asha@example.com'
const requestCode = (api: TestApi, email = ' Asha@Example.com ') => request(api.app).post('/customer/auth/request-code').send({ email })
const verify = (api: TestApi, code: string, email = EMAIL) => request(api.app).post('/customer/auth/verify').send({ email, code })
const latestCode = (api: TestApi) => api.sentCustomerCodes.at(-1)?.code ?? ''
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

/** Signs a customer in fully and returns their token. */
async function signIn(api: TestApi, email = EMAIL): Promise<string> {
  await requestCode(api, email)
  const response = await verify(api, latestCode(api), email)
  expect(response.status).toBe(200)
  return response.body.token as string
}

describe('phone numbers (still used for the optional contact number)', () => {
  it('turns every common way of writing an Indian mobile number into one form', () => {
    for (const typed of ['9824612345', '98246 12345', '09824612345', '919824612345', '+91 98246-12345', '(+91) 9824612345']) expect(normalizePhone(typed)).toBe(PHONE)
    expect(normalizePhone('+14155550123')).toBe('+14155550123')
  })
  it('refuses numbers that cannot be real', () => {
    for (const typed of ['', '12345', '5824612345', '98246123456', 'abcdefghij', '+0123456789']) expect(normalizePhone(typed)).toBeNull()
  })
})

describe('asking for a code', () => {
  it('sends a code for a valid email (tidied up) and never reveals whether it is already a customer', async () => {
    const api = await createTestApi()
    const response = await requestCode(api)
    expect(response.status).toBe(202)
    expect(api.sentCustomerCodes).toEqual([{ email: EMAIL, code: expect.stringMatching(/^\d{6}$/) }])
    expect(response.headers['cache-control']).toBe('no-store')
  })
  it('does not create a customer until the code is checked', async () => {
    const api = await createTestApi()
    await requestCode(api)
    expect(api.customerAuth.customers.size).toBe(0)
  })
  it('stores only a hash of the code', async () => {
    const api = await createTestApi()
    await requestCode(api)
    expect(JSON.stringify(api.customerAuth.codes)).not.toContain(latestCode(api))
  })
  it('refuses an email that is not valid', async () => {
    const api = await createTestApi()
    const response = await requestCode(api, 'not-an-email')
    expect(response.status).toBe(400)
    expect(response.body.error.details[0].field).toBe('email')
  })
  it('makes a person wait a minute between codes, and caps codes per hour', async () => {
    const api = await createTestApi()
    expect((await requestCode(api)).status).toBe(202)
    expect((await requestCode(api)).body.error.code).toBe('CODE_TOO_SOON')
    for (let count = 1; count < MAX_CODES_PER_EMAIL_PER_HOUR; count += 1) {
      api.clock.advanceMinutes(2)
      expect((await requestCode(api)).status).toBe(202)
    }
    api.clock.advanceMinutes(2)
    expect((await requestCode(api)).body.error.code).toBe('TOO_MANY_CODES')
    api.clock.advanceMinutes(60)
    expect((await requestCode(api)).status).toBe(202)
  })
  it('only the newest code works', async () => {
    const api = await createTestApi()
    await requestCode(api)
    const first = latestCode(api)
    api.clock.advanceMinutes(2)
    await requestCode(api)
    const second = latestCode(api)
    expect(first).not.toBe(second)
    expect((await verify(api, first)).status).toBe(401)
    expect((await verify(api, second)).status).toBe(200)
  })
  it('refuses a blocked customer', async () => {
    const api = await createTestApi()
    await signIn(api)
    for (const customer of api.customerAuth.customers.values()) customer.status = 'blocked'
    api.clock.advanceMinutes(2)
    expect((await requestCode(api)).body.error.code).toBe('ACCOUNT_BLOCKED')
  })
})

describe('checking the code', () => {
  it('opens a session, creates the customer on the first sign-in and says the profile is still needed', async () => {
    const api = await createTestApi()
    await requestCode(api)
    const response = await verify(api, latestCode(api))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ isNewCustomer: true, customer: { email: EMAIL, phone: '', name: '', needsProfile: true } })
    expect(response.body.token).toHaveLength(43)
    expect(JSON.stringify(api.customerAuth.sessions)).not.toContain(response.body.token)
    expect(Object.keys(response.body.customer).sort()).toEqual(['email', 'id', 'language', 'name', 'needsProfile', 'phone'])
  })
  it('recognises a returning customer', async () => {
    const api = await createTestApi()
    await signIn(api)
    api.clock.advanceMinutes(2)
    await requestCode(api)
    expect((await verify(api, latestCode(api))).body.isNewCustomer).toBe(false)
    expect(api.customerAuth.customers.size).toBe(1)
  })
  it('refuses a wrong code and locks the code after five wrong tries, even for the right one', async () => {
    const api = await createTestApi()
    await requestCode(api)
    const right = latestCode(api)
    const wrong = right === '000000' ? '111111' : '000000'
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await verify(api, wrong)).body.error.code).toBe('INVALID_CODE')
    expect((await verify(api, right)).status).toBe(401)
  })
  it('refuses an expired code and a code that was already used', async () => {
    const api = await createTestApi()
    await requestCode(api)
    const code = latestCode(api)
    api.clock.advanceMinutes(11)
    expect((await verify(api, code)).status).toBe(401)
    api.clock.advanceMinutes(2)
    await requestCode(api)
    const fresh = latestCode(api)
    expect((await verify(api, fresh)).status).toBe(200)
    expect((await verify(api, fresh)).status).toBe(401)
  })
  it('refuses a code for a different email', async () => {
    const api = await createTestApi()
    await requestCode(api)
    expect((await verify(api, latestCode(api), 'other@example.com')).status).toBe(401)
  })
  it('refuses a code that is not six digits', async () => {
    const api = await createTestApi()
    expect((await verify(api, '12ab')).status).toBe(400)
  })
})

describe('the signed-in customer', () => {
  it('needs a token', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/customer/me')).status).toBe(401)
    expect((await request(api.app).get('/customer/me').set(bearer('not-a-real-token'))).status).toBe(401)
  })
  it('sees their own profile and can fill it in', async () => {
    const api = await createTestApi()
    const token = await signIn(api)
    expect((await request(api.app).get('/customer/me').set(bearer(token))).body.customer).toMatchObject({ email: EMAIL, needsProfile: true })
    const saved = await request(api.app).put('/customer/me').set(bearer(token)).send({ name: '  Asha Patel ', phone: '98246 12345', language: 'gu' })
    expect(saved.body.customer).toMatchObject({ name: 'Asha Patel', email: EMAIL, phone: PHONE, language: 'gu', needsProfile: false })
  })
  it('cannot save a profile without a name or with a bad phone number, and ignores fields it does not know', async () => {
    const api = await createTestApi()
    const token = await signIn(api)
    expect((await request(api.app).put('/customer/me').set(bearer(token)).send({ name: '', language: 'en' })).status).toBe(400)
    expect((await request(api.app).put('/customer/me').set(bearer(token)).send({ name: 'A', phone: '123', language: 'en' })).status).toBe(400)
    await request(api.app).put('/customer/me').set(bearer(token)).send({ name: 'A', language: 'en', status: 'blocked', customerType: 'credit' })
    expect([...api.customerAuth.customers.values()][0]).toMatchObject({ status: 'active', customerType: 'prepaid' })
  })
  it('is signed out by logging out, and the token stops working', async () => {
    const api = await createTestApi()
    const token = await signIn(api)
    expect((await request(api.app).post('/customer/auth/logout').set(bearer(token))).status).toBe(204)
    expect((await request(api.app).get('/customer/me').set(bearer(token))).status).toBe(401)
  })
  it('stays signed in for months, then expires', async () => {
    const api = await createTestApi()
    const token = await signIn(api)
    api.clock.advanceMinutes(60 * 24 * 80)
    expect((await request(api.app).get('/customer/me').set(bearer(token))).status).toBe(200)
    api.clock.advanceMinutes(60 * 24 * 11)
    expect((await request(api.app).get('/customer/me').set(bearer(token))).status).toBe(401)
  })
  it('is signed out at once when blocked', async () => {
    const api = await createTestApi()
    const token = await signIn(api)
    for (const customer of api.customerAuth.customers.values()) customer.status = 'blocked'
    expect((await request(api.app).get('/customer/me').set(bearer(token))).status).toBe(401)
  })
  it('can delete the account: details are blanked, the token stops working and the email can sign up again', async () => {
    const api = await createTestApi()
    const token = await signIn(api)
    expect((await request(api.app).delete('/customer/me').set(bearer(token))).status).toBe(204)
    expect([...api.customerAuth.customers.values()][0]).toMatchObject({ status: 'deleted', phone: null, name: '', email: '' })
    expect((await request(api.app).get('/customer/me').set(bearer(token))).status).toBe(401)
    api.clock.advanceMinutes(2)
    await requestCode(api)
    expect((await verify(api, latestCode(api))).body.isNewCustomer).toBe(true)
  })
})

describe('the store reviewer demo account', () => {
  it('signs in with its fixed code without any email being sent, and other emails are unaffected', async () => {
    const clock = { now: new Date('2026-10-10T10:00:00Z') }
    const sent: string[] = []
    const customers = createFakeCustomerAuthRepository(() => clock.now)
    const service = createCustomerAuthService({
      repository: customers.repository, sender: { channel: 'console', async sendCode(email) { sent.push(email) } }, secret: SECRET, now: () => clock.now,
      reviewAccount: { email: 'reviewer@example.com', code: '424242' },
    })
    await service.requestCode('reviewer@example.com', '1.1.1.1')
    expect(sent).toEqual([])
    const session = await service.verifyCode('reviewer@example.com', '424242', 'test')
    expect(session.customer.email).toBe('reviewer@example.com')
    await service.requestCode('someone@example.com', '1.1.1.1')
    expect(sent).toEqual(['someone@example.com'])
    await expect(service.verifyCode('someone@example.com', '424242', 'test')).rejects.toMatchObject({ code: 'INVALID_CODE' })
  })
})
