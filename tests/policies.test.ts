import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { renderLegalPage } from '../src/modules/policies/legal-page.js'
import { nextVersion } from '../src/modules/policies/service.js'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const call = (api: TestApi, cookie: string, method: 'post' | 'put' | 'delete', path: string, body: object = {}) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
const BODY = 'We collect your name, phone number and delivery address only to deliver your orders. We never sell your data.'
const draft = (extra: object = {}) => ({ type: 'privacy', titleEn: 'Privacy Policy', bodyEn: BODY, version: '1.0', effectiveDate: '2026-10-01', ...extra })

async function published(api: TestApi, cookie: string, extra: object = {}) {
  const created = await call(api, cookie, 'post', '/admin/policies', draft(extra))
  const live = await call(api, cookie, 'post', `/admin/policies/${created.body.policy.id}/publish`)
  return live.body.policy as { id: string; version: string }
}

describe('policy versions (admin)', () => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/policies')).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post('/admin/policies').set('Cookie', cookie).set('Origin', 'https://evil.example').send(draft())
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(api.policies.rows).toHaveLength(0)
  })
  it('creates a draft, edits it, and refuses the same version twice for one policy', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const created = await call(api, cookie, 'post', '/admin/policies', draft())
    expect([created.status, created.body.policy.status, created.body.policy.publishedAt]).toEqual([201, 'draft', null])
    const id = created.body.policy.id as string
    expect((await call(api, cookie, 'put', `/admin/policies/${id}`, draft({ titleEn: 'Our Privacy Policy' }))).body.policy.titleEn).toBe('Our Privacy Policy')
    const duplicate = await call(api, cookie, 'post', '/admin/policies', draft({ version: ' 1.0 ' }))
    expect([duplicate.status, duplicate.body.error.code]).toEqual([409, 'POLICY_VERSION_EXISTS'])
    expect((await call(api, cookie, 'post', '/admin/policies', draft({ type: 'terms' }))).status).toBe(201)
  })
  it('refuses bad input, naming the field', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const bad = await call(api, cookie, 'post', '/admin/policies', { type: 'cookies', titleEn: ' ', bodyEn: 'x'.repeat(20_001), version: '', effectiveDate: '2026-02-30' })
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['bodyEn', 'effectiveDate', 'titleEn', 'type', 'version'])
  })
  it('publishes a draft, archives the one it replaces, and keeps exactly one live', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const first = await published(api, cookie)
    const second = await call(api, cookie, 'post', '/admin/policies', draft({ version: '1.1', effectiveDate: '2026-11-01' }))
    const live = await call(api, cookie, 'post', `/admin/policies/${second.body.policy.id}/publish`)
    expect([live.status, live.body.policy.status]).toEqual([200, 'published'])
    const all = (await request(api.app).get('/admin/policies').set('Cookie', cookie)).body.policies as Array<{ id: string; status: string }>
    expect(all.filter(item => item.status === 'published')).toHaveLength(1)
    expect(all.find(item => item.id === first.id)?.status).toBe('archived')
    expect(api.audit.find(entry => entry.action === 'policy_published' && JSON.stringify(entry.details).includes('"replaced":"1.0"'))).toBeDefined()
  })
  it('refuses to publish text that is too short, a version dated before the one it replaces, or something that is not a draft', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const stub = await call(api, cookie, 'post', '/admin/policies', draft({ bodyEn: 'Too short.' }))
    expect((await call(api, cookie, 'post', `/admin/policies/${stub.body.policy.id}/publish`)).body.error.code).toBe('POLICY_TOO_SHORT')
    const live = await published(api, cookie, { version: '2.0', effectiveDate: '2026-10-10' })
    const earlier = await call(api, cookie, 'post', '/admin/policies', draft({ version: '2.1', effectiveDate: '2026-10-09' }))
    expect((await call(api, cookie, 'post', `/admin/policies/${earlier.body.policy.id}/publish`)).body.error.code).toBe('POLICY_DATE_ORDER')
    expect((await call(api, cookie, 'post', `/admin/policies/${live.id}/publish`)).body.error.code).toBe('POLICY_NOT_DRAFT')
    expect(api.policies.rows.filter(row => row.status === 'published')).toHaveLength(1)
  })
  it('never edits or deletes history: published and archived versions are fixed', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const live = await published(api, cookie)
    const edit = await call(api, cookie, 'put', `/admin/policies/${live.id}`, draft({ titleEn: 'Sneaky change' }))
    expect([edit.status, edit.body.error.code]).toEqual([409, 'POLICY_NOT_DRAFT'])
    expect((await call(api, cookie, 'delete', `/admin/policies/${live.id}`)).body.error.code).toBe('POLICY_NOT_DRAFT')
    await call(api, cookie, 'post', `/admin/policies/${live.id}/archive`)
    expect((await call(api, cookie, 'put', `/admin/policies/${live.id}`, draft())).body.error.code).toBe('POLICY_NOT_DRAFT')
    expect((await call(api, cookie, 'delete', `/admin/policies/${live.id}`)).status).toBe(409)
    expect(api.policies.rows.find(row => row.id === live.id)?.titleEn).toBe('Privacy Policy')
  })
  it('starts a new version as a draft copy with the next number, and lets a draft be discarded', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const live = await published(api, cookie)
    const copy = await call(api, cookie, 'post', `/admin/policies/${live.id}/new-version`)
    expect([copy.status, copy.body.policy.version, copy.body.policy.status, copy.body.policy.bodyEn]).toEqual([201, '1.1', 'draft', BODY])
    expect((await call(api, cookie, 'delete', `/admin/policies/${copy.body.policy.id}`)).status).toBe(204)
    expect(api.policies.rows).toHaveLength(1)
  })
  it('archives only a published version, so a draft is discarded instead', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const stub = await call(api, cookie, 'post', '/admin/policies', draft())
    expect((await call(api, cookie, 'post', `/admin/policies/${stub.body.policy.id}/archive`)).body.error.code).toBe('POLICY_NOT_PUBLISHED')
    const live = await published(api, cookie, { version: '2.0' })
    expect((await call(api, cookie, 'post', `/admin/policies/${live.id}/archive`)).body.policy.status).toBe('archived')
    expect((await call(api, cookie, 'post', `/admin/policies/${live.id}/archive`)).body.error.code).toBe('POLICY_NOT_PUBLISHED')
  })
  it('suggests the next version number', () => {
    expect(nextVersion([])).toBe('1.0')
    expect(nextVersion(['1.0', '1.9'])).toBe('1.10')
    expect(nextVersion(['2', '1.5'])).toBe('2.1')
    expect(nextVersion(['draft-a'])).toBe('1.0')
  })
})

describe('policies (what customers and stores read)', () => {
  it('lists only published versions, without staff details, and needs no sign-in', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    await published(api, cookie)
    await call(api, cookie, 'post', '/admin/policies', draft({ type: 'terms' }))
    const response = await request(api.app).get('/public/policies')
    expect(response.status).toBe(200)
    expect(response.body.policies).toHaveLength(1)
    expect(Object.keys(response.body.policies[0]).sort()).toEqual(['bodyEn', 'bodyGu', 'effectiveDate', 'id', 'titleEn', 'titleGu', 'type', 'version'])
  })
  it('serves a public web page for a published policy, in English or Gujarati, and a clear 404 page otherwise', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await request(api.app).get('/legal/privacy')).status).toBe(404)
    await published(api, cookie, { titleGu: 'ગોપનીયતા નીતિ', bodyGu: 'અમે તમારી માહિતી સુરક્ષિત રાખીએ છીએ.\n\nઅમે તેને વેચતા નથી.' })
    const english = await request(api.app).get('/legal/privacy')
    expect([english.status, english.headers['content-type']]).toEqual([200, 'text/html; charset=utf-8'])
    expect(english.text).toContain('<h1>Privacy Policy</h1>')
    expect(english.text).toContain('Version 1.0')
    const gujarati = await request(api.app).get('/legal/privacy?lang=gu')
    expect(gujarati.text).toContain('<h1>ગોપનીયતા નીતિ</h1>')
    expect((gujarati.text.match(/<p>/g) ?? []).length).toBe(2)
    expect((await request(api.app).get('/legal/cookies')).status).toBe(400)
    expect((await request(api.app).get('/legal/privacy?lang=fr')).status).toBe(400)
  })
  it('falls back to English when the Gujarati text is missing', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    await published(api, cookie)
    const page = await request(api.app).get('/legal/privacy?lang=gu')
    expect(page.text).toContain('<h1>Privacy Policy</h1>')
    expect(page.text).toContain('lang="en"')
  })
  it('can never inject markup into the page', () => {
    const html = renderLegalPage({ id: '1', type: 'privacy', titleEn: '<script>alert(1)</script>', titleGu: '', bodyEn: '<img src=x onerror=alert(1)>\n\n"quoted" & more', bodyGu: '', version: '1"><b>', effectiveDate: '2026-10-10' }, 'en')
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('"><b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&quot;quoted&quot; &amp; more')
  })
  it('shows a published change at once, and an archived policy disappears', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const live = await published(api, cookie)
    expect((await request(api.app).get('/legal/privacy')).status).toBe(200)
    await call(api, cookie, 'post', `/admin/policies/${live.id}/archive`)
    expect((await request(api.app).get('/legal/privacy')).status).toBe(404)
    expect((await request(api.app).get('/public/policies')).body.policies).toHaveLength(0)
  })
})
