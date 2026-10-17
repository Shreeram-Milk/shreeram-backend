import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { hashPassword, newCode, sha256, verifyPassword } from '../src/modules/auth/crypto.js'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

const EMAIL = 'owner@example.com'
const post = (api: TestApi, path: string, body: object, origin: string | null = ADMIN_ORIGIN) => {
  const call = request(api.app).post(path).send(body)
  return origin ? call.set('Origin', origin) : call
}
const login = (api: TestApi, password = PASSWORD) => post(api, '/admin/auth/login', { email: EMAIL, password })
const verify = (api: TestApi, code: string) => post(api, '/admin/auth/verify', { email: EMAIL, code })
const latestCode = (api: TestApi) => api.sentCodes.at(-1)?.code ?? ''
const cookieOf = (response: request.Response) => (response.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(';')[0] ?? ''

/** Signs in fully and returns the session cookie. */
async function signIn(api: TestApi): Promise<string> {
  await login(api)
  const response = await verify(api, latestCode(api))
  expect(response.status).toBe(200)
  return cookieOf(response)
}

describe('passwords and codes', () => {
  it('hashes with a random salt, verifies the right password only, and never stores the password', async () => {
    const [one, two] = await Promise.all([hashPassword('secret-password'), hashPassword('secret-password')])
    expect(one).not.toBe(two)
    expect(one).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(one).not.toContain('secret-password')
    expect(await verifyPassword('secret-password', one)).toBe(true)
    expect(await verifyPassword('secret-passworD', one)).toBe(false)
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false)
  })
  it('makes six-digit codes', () => {
    for (let index = 0; index < 50; index += 1) expect(newCode()).toMatch(/^\d{6}$/)
  })
})

describe('signing in', () => {
  it('takes a password, then an emailed code, then opens a session in a protected cookie', async () => {
    const api = await createTestApi()
    const step1 = await login(api)
    expect([step1.status, step1.body]).toEqual([202, { status: 'code_sent' }])
    expect(api.sentCodes).toHaveLength(1)
    const step2 = await verify(api, latestCode(api))
    expect(step2.status).toBe(200)
    expect(step2.body.admin.email).toBe(EMAIL)
    const setCookie = (step2.headers['set-cookie'] as unknown as string[])[0] ?? ''
    expect(setCookie).toMatch(/sr_admin_session=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).toMatch(/Expires=/i)
    const me = await request(api.app).get('/admin/auth/me').set('Cookie', cookieOf(step2))
    expect([me.status, me.body.admin.email]).toEqual([200, EMAIL])
  })
  it('stores only hashes: not the code, and not the session token', async () => {
    const api = await createTestApi()
    const cookie = await signIn(api)
    const token = decodeURIComponent(cookie.split('=')[1] ?? '')
    expect(api.sentCodes).toHaveLength(1)
    expect(api.auth.codes.every(code => code.codeHash !== latestCode(api))).toBe(true)
    expect(api.auth.sessions.map(session => session.tokenHash)).toEqual([sha256(token)])
    expect(JSON.stringify(api.audit)).not.toMatch(new RegExp(`${PASSWORD}|${token}`))
  })
  it('refuses a request with no session, and a made-up cookie', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/auth/me')).status).toBe(401)
    expect((await request(api.app).get('/admin/auth/me').set('Cookie', 'sr_admin_session=made-up')).status).toBe(401)
  })
  it('signs out for real: the cookie stops working', async () => {
    const api = await createTestApi()
    const cookie = await signIn(api)
    const out = await request(api.app).post('/admin/auth/logout').set('Origin', ADMIN_ORIGIN).set('Cookie', cookie)
    expect(out.status).toBe(204)
    expect((await request(api.app).get('/admin/auth/me').set('Cookie', cookie)).status).toBe(401)
  })
  it('ends a session after seven days', async () => {
    const api = await createTestApi()
    const cookie = await signIn(api)
    api.clock.advanceMinutes(60 * 24 * 6)
    expect((await request(api.app).get('/admin/auth/me').set('Cookie', cookie)).status).toBe(200)
    api.clock.advanceMinutes(60 * 24 * 2)
    expect((await request(api.app).get('/admin/auth/me').set('Cookie', cookie)).status).toBe(401)
  })
  it('does not let a disabled admin in, even with a valid session', async () => {
    const api = await createTestApi()
    const cookie = await signIn(api)
    api.auth.admins.forEach(admin => { admin.status = 'disabled' })
    expect((await request(api.app).get('/admin/auth/me').set('Cookie', cookie)).status).toBe(401)
    expect((await login(api)).body.error.code).toBe('INVALID_CREDENTIALS')
  })
})

describe('wrong answers', () => {
  it('gives the same answer for a wrong password and an unknown email', async () => {
    const api = await createTestApi()
    const wrong = await login(api, 'not the password')
    const unknown = await post(api, '/admin/auth/login', { email: 'nobody@example.com', password: PASSWORD })
    expect([wrong.status, wrong.body]).toEqual([unknown.status, unknown.body])
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS')
    expect(api.sentCodes).toHaveLength(0)
  })
  it('locks the account after five wrong passwords, then lets it in again after fifteen minutes', async () => {
    const api = await createTestApi()
    for (let index = 0; index < 5; index += 1) expect((await login(api, 'wrong')).status).toBe(401)
    const locked = await login(api)
    expect([locked.status, locked.body.error.code]).toEqual([429, 'ACCOUNT_LOCKED'])
    expect(api.sentCodes).toHaveLength(0)
    api.clock.advanceMinutes(16)
    expect((await login(api)).status).toBe(202)
  })
  it('rejects a wrong code and never leaks which part was wrong', async () => {
    const api = await createTestApi()
    await login(api)
    const wrong = await verify(api, latestCode(api) === '000000' ? '111111' : '000000')
    expect([wrong.status, wrong.body.error.code]).toEqual([401, 'INVALID_CODE'])
    const noAccount = await post(api, '/admin/auth/verify', { email: 'nobody@example.com', code: '123456' })
    expect(noAccount.body.error).toEqual(wrong.body.error)
  })
  it('stops accepting a code after five wrong tries, even the right one', async () => {
    const api = await createTestApi()
    await login(api)
    const right = latestCode(api)
    const wrong = right === '000000' ? '111111' : '000000'
    for (let index = 0; index < 5; index += 1) await verify(api, wrong)
    expect((await verify(api, right)).status).toBe(401)
  })
  it('expires a code after ten minutes', async () => {
    const api = await createTestApi()
    await login(api)
    api.clock.advanceMinutes(11)
    expect((await verify(api, latestCode(api))).status).toBe(401)
  })
  it('lets a code be used only once', async () => {
    const api = await createTestApi()
    await login(api)
    const code = latestCode(api)
    expect((await verify(api, code)).status).toBe(200)
    expect((await verify(api, code)).status).toBe(401)
  })
  it('makes a new code cancel the old one', async () => {
    const api = await createTestApi()
    await login(api)
    const first = latestCode(api)
    await login(api)
    const second = latestCode(api)
    if (first !== second) expect((await verify(api, first)).status).toBe(401)
    expect((await verify(api, second)).status).toBe(200)
  })
  it('rejects malformed input before it reaches the account', async () => {
    const api = await createTestApi()
    expect((await post(api, '/admin/auth/login', { email: 'not-an-email', password: 'x' })).body.error.code).toBe('VALIDATION_ERROR')
    expect((await post(api, '/admin/auth/verify', { email: EMAIL, code: '12345' })).body.error.code).toBe('VALIDATION_ERROR')
    expect((await post(api, '/admin/auth/verify', { email: EMAIL, code: 'abcdef' })).body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('protection against misuse', () => {
  it('refuses a change that does not come from the admin site', async () => {
    const api = await createTestApi()
    for (const origin of [null, 'https://evil.example', 'http://localhost:9999']) {
      const response = await post(api, '/admin/auth/login', { email: EMAIL, password: PASSWORD }, origin)
      expect([response.status, response.body.error.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED'])
    }
    expect(api.sentCodes).toHaveLength(0)
  })
  it('stops a flood of sign-in attempts from one address after ten tries', async () => {
    const api = await createTestApi()
    const statuses: number[] = []
    for (let index = 0; index < 12; index += 1) statuses.push((await post(api, '/admin/auth/login', { email: 'nobody@example.com', password: 'x' })).status)
    expect(statuses.slice(0, 10).every(status => status === 401)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })
  it('writes an audit trail of sign-ins without secrets', async () => {
    const api = await createTestApi()
    await login(api, 'wrong')
    await signIn(api)
    expect(api.audit.map(entry => entry.action)).toEqual(['login_failed', 'login_code_sent', 'login_succeeded'])
    expect(JSON.stringify(api.audit)).not.toContain(PASSWORD)
    expect(JSON.stringify(api.audit)).not.toContain(latestCode(api))
  })
})
