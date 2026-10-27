import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { AppError } from '../src/http/errors.js'
import { createGoogleIdTokenVerifier, type GoogleIdentity, type GoogleIdTokenVerifier } from '../src/integrations/google/id-token.js'
import { createTestApi, type TestApi } from './fakes.js'

const TOKEN = 'a-google-id-token-that-is-long-enough'
const identity = (extra: Partial<GoogleIdentity> = {}): GoogleIdentity => ({ subject: 'google-sub-1', email: 'asha@gmail.com', emailVerified: true, name: 'Asha Patel', ...extra })
/** A verifier that "decodes" the token to whatever identity the test set, like Google's check would. */
const verifierFor = (current: { value: GoogleIdentity | 'invalid' }): GoogleIdTokenVerifier => async () => {
  if (current.value === 'invalid') throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified. Please try again.')
  return current.value
}
const google = (api: TestApi, idToken = TOKEN) => request(api.app).post('/customer/auth/google').send({ idToken, deviceLabel: 'Pixel 7' })
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('Continue with Google', () => {
  it('creates a customer from a verified Google account and signs them in', async () => {
    const current = { value: identity() as GoogleIdentity | 'invalid' }
    const api = await createTestApi({ googleVerifier: verifierFor(current) })
    const response = await google(api)
    expect(response.status).toBe(200)
    expect(response.body.isNewCustomer).toBe(true)
    expect(response.body.customer).toMatchObject({ email: 'asha@gmail.com', name: 'Asha Patel' })
    expect(api.customerAuth.sessions.at(-1)?.method).toBe('google')
    const me = await request(api.app).get('/customer/me').set(bearer(response.body.token as string))
    expect(me.status).toBe(200)
    expect(me.body.customer.email).toBe('asha@gmail.com')
  })

  it('signs the same Google account into the same customer the next time', async () => {
    const api = await createTestApi({ googleVerifier: verifierFor({ value: identity() }) })
    const first = await google(api)
    const second = await google(api)
    expect(second.status).toBe(200)
    expect(second.body.isNewCustomer).toBe(false)
    expect(second.body.customer.id).toBe(first.body.customer.id)
    expect(api.customerAuth.customers.size).toBe(1)
  })

  it('links a customer who first used an emailed code to the same account, never a duplicate', async () => {
    const api = await createTestApi({ googleVerifier: verifierFor({ value: identity() }) })
    await request(api.app).post('/customer/auth/request-code').send({ email: 'asha@gmail.com' })
    const viaCode = await request(api.app).post('/customer/auth/verify').send({ email: 'asha@gmail.com', code: api.sentCustomerCodes.at(-1)?.code })
    const viaGoogle = await google(api)
    expect(viaGoogle.status).toBe(200)
    expect(viaGoogle.body.isNewCustomer).toBe(false)
    expect(viaGoogle.body.customer.id).toBe(viaCode.body.customer.id)
    expect(api.customerAuth.customers.size).toBe(1)
    expect(api.customerAuth.sessions.map(session => session.method)).toEqual(['email_code', 'google'])
  })

  it('refuses a verifier-rejected token, an unverified Google email, and a malformed request', async () => {
    const current = { value: 'invalid' as GoogleIdentity | 'invalid' }
    const api = await createTestApi({ googleVerifier: verifierFor(current) })
    const bad = await google(api)
    expect([bad.status, bad.body.error.code]).toEqual([401, 'INVALID_GOOGLE_TOKEN'])
    current.value = identity({ emailVerified: false })
    const unverified = await google(api)
    expect([unverified.status, unverified.body.error.code]).toEqual([403, 'GOOGLE_EMAIL_NOT_VERIFIED'])
    expect((await google(api, 'short')).status).toBe(400)
    expect((await request(api.app).post('/customer/auth/google').send({})).status).toBe(400)
    expect(api.customerAuth.customers.size).toBe(0)
  })

  it('refuses a blocked customer, and says so plainly', async () => {
    const api = await createTestApi({ googleVerifier: verifierFor({ value: identity() }) })
    await google(api)
    for (const customer of api.customerAuth.customers.values()) customer.status = 'blocked'
    const response = await google(api)
    expect([response.status, response.body.error.code]).toEqual([403, 'ACCOUNT_BLOCKED'])
  })

  it('never merges an email that already belongs to another Google account', async () => {
    const current = { value: identity() as GoogleIdentity | 'invalid' }
    const api = await createTestApi({ googleVerifier: verifierFor(current) })
    await google(api)
    current.value = identity({ subject: 'google-sub-2' })
    const response = await google(api)
    expect([response.status, response.body.error.code]).toEqual([409, 'GOOGLE_ACCOUNT_CONFLICT'])
    expect(api.customerAuth.customers.size).toBe(1)
  })

  it('starts a new account after the old one was deleted', async () => {
    const api = await createTestApi({ googleVerifier: verifierFor({ value: identity() }) })
    const first = await google(api)
    expect((await request(api.app).delete('/customer/me').set(bearer(first.body.token as string))).status).toBe(204)
    const again = await google(api)
    expect(again.status).toBe(200)
    expect(again.body.isNewCustomer).toBe(true)
    expect(again.body.customer.id).not.toBe(first.body.customer.id)
  })

  it('says it is unavailable when the server has no Google client id', async () => {
    const api = await createTestApi()
    const response = await google(api)
    expect([response.status, response.body.error.code]).toEqual([503, 'GOOGLE_SIGN_IN_UNAVAILABLE'])
  })
})

describe('the Google token check', () => {
  const clientId = '123456-abc.apps.googleusercontent.com'
  const checker = (payload: Record<string, unknown> | null | 'throw') => createGoogleIdTokenVerifier(clientId, {
    verifyIdToken: async ({ audience }) => {
      if (payload === 'throw') throw new Error('Wrong recipient')
      expect(audience).toBe(clientId)
      return { getPayload: () => payload } as never
    },
  })

  it('asks Google to check the token for OUR app and returns who it is, with the email in lower case', async () => {
    const result = await checker({ sub: 'abc', email: 'Asha@Gmail.com', email_verified: true, name: ' Asha Patel ' })('token')
    expect(result).toEqual({ subject: 'abc', email: 'asha@gmail.com', emailVerified: true, name: 'Asha Patel' })
  })

  it('treats anything but an explicit verified email as unverified', async () => {
    expect((await checker({ sub: 'abc', email: 'a@b.com' })('token')).emailVerified).toBe(false)
    expect((await checker({ sub: 'abc', email: 'a@b.com', email_verified: 'true' })('token')).emailVerified).toBe(false)
  })

  it('gives the same plain refusal for a bad signature, a wrong app, or a token with no email', async () => {
    for (const payload of ['throw', null, { sub: 'abc' }] as const) {
      await expect(checker(payload)('token')).rejects.toMatchObject({ status: 401, code: 'INVALID_GOOGLE_TOKEN' })
    }
  })
})
