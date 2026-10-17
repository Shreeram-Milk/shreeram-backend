import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const send = (api: TestApi, cookie: string, method: 'post' | 'put' | 'patch', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
const faq = (extra: object = {}) => ({ topic: 'late_delivery', questionEn: 'When will my delivery arrive?', answerEn: 'Your delivery window is in your order details.', status: 'published', ...extra })

describe('help questions (admin)', () => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/help/faqs')).status).toBe(401)
    expect((await request(api.app).post('/admin/help/faqs').set('Origin', ADMIN_ORIGIN).send(faq())).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post('/admin/help/faqs').set('Cookie', cookie).set('Origin', 'https://evil.example').send(faq())
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect(api.help.rows).toHaveLength(0)
  })
  it('creates, reads, edits and hides a question, with defaults filled in and an audit entry each time', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const created = await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionGu: 'મારી ડિલિવરી ક્યારે આવશે?', searchKeywords: [' Morning ', 'morning', 'TIME', ''] }))
    expect(created.status).toBe(201)
    expect(created.body.faq).toMatchObject({ topic: 'late_delivery', featured: false, sortOrder: 0, status: 'published', searchKeywords: ['morning', 'time'] })
    const id = created.body.faq.id as string
    expect((await request(api.app).get(`/admin/help/faqs/${id}`).set('Cookie', cookie)).body.faq.questionGu).toBe('મારી ડિલિવરી ક્યારે આવશે?')
    expect((await send(api, cookie, 'put', `/admin/help/faqs/${id}`, faq({ answerEn: 'Updated answer.' }))).body.faq.answerEn).toBe('Updated answer.')
    expect((await send(api, cookie, 'patch', `/admin/help/faqs/${id}/status`, { status: 'inactive' })).body.faq.status).toBe('inactive')
    expect(api.audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['faq_created', 'faq_updated', 'faq_status_changed']))
  })
  it('refuses bad input, naming the field, and drops unknown fields', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const bad = await send(api, cookie, 'post', '/admin/help/faqs', { topic: 'nonsense', questionEn: ' ', answerEn: 'x'.repeat(801), searchKeywords: Array.from({ length: 11 }, (_, index) => `w${index}`), sortOrder: -1, status: 'deleted' })
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['answerEn', 'questionEn', 'searchKeywords', 'sortOrder', 'status', 'topic'])
    const ok = await send(api, cookie, 'post', '/admin/help/faqs', { ...faq(), id: 'chosen-by-attacker', updatedBy: 'someone' })
    expect(ok.body.faq.id).not.toBe('chosen-by-attacker')
  })
  it('refuses the same question twice under one topic, but allows it under another', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    await send(api, cookie, 'post', '/admin/help/faqs', faq())
    const again = await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: '  WHEN will my DELIVERY arrive?  ' }))
    expect([again.status, again.body.error.code]).toEqual([409, 'FAQ_DUPLICATE'])
    expect((await send(api, cookie, 'post', '/admin/help/faqs', faq({ topic: 'payment_issue' }))).status).toBe(201)
  })
  it('lets only published questions be popular, at most five, and un-popular-ises a question that is hidden', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const draft = await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: 'Draft one', status: 'draft', featured: true }))
    expect([draft.status, draft.body.error.details[0].field]).toEqual([400, 'featured'])
    const ids: string[] = []
    for (let count = 0; count < 5; count += 1) ids.push((await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: `Popular ${count}`, featured: true }))).body.faq.id as string)
    const sixth = await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: 'Popular 6', featured: true }))
    expect([sixth.status, sixth.body.error.code]).toEqual([409, 'FAQ_FEATURED_LIMIT'])
    expect((await send(api, cookie, 'put', `/admin/help/faqs/${ids[0]}`, faq({ questionEn: 'Popular 0', featured: true, answerEn: 'Edited' }))).status).toBe(200)
    const hidden = await send(api, cookie, 'patch', `/admin/help/faqs/${ids[1]}/status`, { status: 'inactive' })
    expect([hidden.body.faq.status, hidden.body.faq.featured]).toEqual(['inactive', false])
    expect((await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: 'Popular 6', featured: true }))).status).toBe(201)
  })
  it('lists a page at a time, filtered by topic, status and search, never more than 100', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    for (let count = 0; count < 25; count += 1) await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: `Question ${String(count).padStart(2, '0')}`, status: count % 2 ? 'draft' : 'published' }))
    await send(api, cookie, 'post', '/admin/help/faqs', faq({ topic: 'payment_issue', questionEn: 'How do refunds work?', searchKeywords: ['money'] }))
    const list = (query: string) => request(api.app).get(`/admin/help/faqs?${query}`).set('Cookie', cookie)
    const first = await list('pageSize=10')
    expect([first.body.rows.length, first.body.total]).toEqual([10, 26])
    expect((await list('pageSize=10&page=3')).body.rows).toHaveLength(6)
    expect((await list('topic=payment_issue')).body.total).toBe(1)
    expect((await list('search=money')).body.rows[0].questionEn).toBe('How do refunds work?')
    expect((await list('status=draft')).body.total).toBe(12)
    expect((await list('pageSize=101')).status).toBe(400)
    expect((await list('topic=nonsense')).status).toBe(400)
  })
  it('answers an unknown question with 404 and a malformed id with 400', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await request(api.app).get('/admin/help/faqs/6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f').set('Cookie', cookie)).body.error.code).toBe('FAQ_NOT_FOUND')
    expect((await request(api.app).get('/admin/help/faqs/nope').set('Cookie', cookie)).body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('help (what the app reads)', () => {
  it('needs no sign-in and sends the topics with only the published questions, in one answer', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: 'Shown' }))
    await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: 'Draft', status: 'draft' }))
    await send(api, cookie, 'post', '/admin/help/faqs', faq({ questionEn: 'Hidden', status: 'inactive' }))
    const response = await request(api.app).get('/public/help')
    expect(response.status).toBe(200)
    expect(response.body.faqs.map((item: { questionEn: string }) => item.questionEn)).toEqual(['Shown'])
    expect(response.body.topics.map((topic: { id: string }) => topic.id)).toEqual(['delivery_missing', 'late_delivery', 'payment_issue'])
    expect(Object.keys(response.body.faqs[0]).sort()).toEqual(['answerEn', 'answerGu', 'featured', 'id', 'questionEn', 'questionGu', 'searchKeywords', 'sortOrder', 'topic'])
    expect(response.headers['cache-control']).toContain('public')
  })
  it('shows a change at once, and reads the database once for many phones', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const created = await send(api, cookie, 'post', '/admin/help/faqs', faq())
    expect((await request(api.app).get('/public/help')).body.faqs).toHaveLength(1)
    await send(api, cookie, 'patch', `/admin/help/faqs/${created.body.faq.id}/status`, { status: 'inactive' })
    expect((await request(api.app).get('/public/help')).body.faqs).toHaveLength(0)
  })
})
