import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { MAX_NEW_TICKETS_PER_HOUR } from '../src/modules/support-tickets/schema.js'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'
import { signUpByEmail } from './checkout-helpers.js'

async function adminCookie(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}

async function signUp(api: TestApi, phone: string): Promise<string> {
  return (await signUpByEmail(api, phone)).token
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const report = { category: 'late_delivery', description: 'The milk came after nine this morning.' }
const open = (api: TestApi, token: string, body: object = report) => request(api.app).post('/customer/support/tickets').set(bearer(token)).send(body)
const admin = (api: TestApi, cookie: string) => ({
  get: (path: string) => request(api.app).get(`/admin/support-tickets${path}`).set('Cookie', cookie),
  post: (path: string, body: object) => request(api.app).post(`/admin/support-tickets${path}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body),
  patch: (path: string, body: object) => request(api.app).patch(`/admin/support-tickets${path}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body),
  put: (path: string, body: object) => request(api.app).put(`/admin/support-tickets${path}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body),
})

describe('a customer reporting a problem', () => {
  it('needs a signed-in customer and is never cached', async () => {
    const api = await createTestApi()
    expect((await request(api.app).post('/customer/support/tickets').send(report)).status).toBe(401)
    const token = await signUp(api, '9824612345')
    expect((await open(api, token)).headers['cache-control']).toBe('no-store')
  })

  it('opens a ticket with a reference number and shows it in their own list', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    const created = await open(api, token)
    expect(created.status).toBe(201)
    expect(created.body.ticket).toMatchObject({ reference: 'TKT-1001', category: 'late_delivery', status: 'open', messageCount: 1 })
    expect(Object.keys(created.body.ticket).sort()).toEqual(['category', 'createdAt', 'id', 'messageCount', 'reference', 'status', 'updatedAt'])
    const list = await request(api.app).get('/customer/support/tickets').set(bearer(token))
    expect(list.body.rows.map((row: { reference: string }) => row.reference)).toEqual(['TKT-1001'])
  })

  it('refuses a report that is too short, too long, or about an unknown topic', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    expect((await open(api, token, { ...report, description: 'late' })).body.error.details[0].field).toBe('description')
    expect((await open(api, token, { ...report, description: 'x'.repeat(1001) })).status).toBe(400)
    expect((await open(api, token, { ...report, category: 'weather' })).status).toBe(400)
  })

  it('limits how many reports one customer can send in an hour', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    for (let count = 0; count < MAX_NEW_TICKETS_PER_HOUR; count += 1) expect((await open(api, token)).status).toBe(201)
    expect((await open(api, token)).body.error.code).toBe('TOO_MANY_TICKETS')
    api.clock.advanceMinutes(61)
    expect((await open(api, token)).status).toBe(201)
  })

  it('never shows one customer another customer\'s ticket', async () => {
    const api = await createTestApi()
    const asha = await signUp(api, '9824612345')
    const ravi = await signUp(api, '9876543210')
    const { id } = (await open(api, asha)).body.ticket
    expect((await request(api.app).get('/customer/support/tickets').set(bearer(ravi))).body.rows).toEqual([])
    expect((await request(api.app).get(`/customer/support/tickets/${id}`).set(bearer(ravi))).status).toBe(404)
    expect((await request(api.app).post(`/customer/support/tickets/${id}/messages`).set(bearer(ravi)).send({ body: 'hello' })).status).toBe(404)
  })

  it('sees the thread with staff replies shown only as "support", never a staff email', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const token = await signUp(api, '9824612345')
    const { id } = (await open(api, token)).body.ticket
    await admin(api, cookie).post(`/${id}/messages`, { body: 'Sorry about that. Your delivery slot was moved.' })
    const thread = (await request(api.app).get(`/customer/support/tickets/${id}`).set(bearer(token))).body
    expect(thread.messages.map((message: { author: string }) => message.author)).toEqual(['customer', 'support'])
    expect(JSON.stringify(thread)).not.toContain('owner@example.com')
    expect(thread.ticket.status).toBe('in_progress')
  })

  it('can reply, and replying on a resolved ticket reopens it, but a closed ticket takes nothing more', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const token = await signUp(api, '9824612345')
    const { id } = (await open(api, token)).body.ticket
    const reply = (body: string) => request(api.app).post(`/customer/support/tickets/${id}/messages`).set(bearer(token)).send({ body })
    expect((await reply('One more detail: it was the 1 litre pack.')).body.messages).toHaveLength(2)
    await admin(api, cookie).patch(`/${id}/status`, { status: 'resolved' })
    expect((await reply('It is still not here.')).body.ticket.status).toBe('open')
    await admin(api, cookie).patch(`/${id}/status`, { status: 'in_progress' })
    await admin(api, cookie).patch(`/${id}/status`, { status: 'resolved' })
    await admin(api, cookie).patch(`/${id}/status`, { status: 'closed' })
    expect((await reply('Hello again')).body.error.code).toBe('TICKET_CLOSED')
  })
})

describe('staff working tickets', () => {
  it('need a signed-in admin, and a trusted origin to change anything', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    const { id } = (await open(api, token)).body.ticket
    expect((await request(api.app).get('/admin/support-tickets')).status).toBe(401)
    const cookie = await adminCookie(api)
    expect((await request(api.app).post(`/admin/support-tickets/${id}/messages`).set('Cookie', cookie).send({ body: 'hi' })).status).toBe(403)
  })

  it('list newest activity first, with search, filters and paging', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const asha = await signUp(api, '9824612345')
    const ravi = await signUp(api, '9876543210')
    await request(api.app).put('/customer/me').set(bearer(asha)).send({ name: 'Asha Patel', email: '', language: 'en' })
    await open(api, asha)
    await open(api, ravi, { category: 'payment_issue', description: 'I was charged twice for one order.' })
    const staff = admin(api, cookie)
    expect((await staff.get('')).body.total).toBe(2)
    expect((await staff.get('?search=asha')).body.rows).toHaveLength(1)
    expect((await staff.get('?search=TKT-1002')).body.rows[0].category).toBe('payment_issue')
    expect((await staff.get('?category=late_delivery')).body.total).toBe(1)
    expect((await staff.get('?pageSize=1&page=2')).body.rows).toHaveLength(1)
    expect((await staff.get('?status=resolved')).body.total).toBe(0)
    expect((await staff.get('')).body.rows[0].ticketNumber).toBe(1002)
    expect((await staff.get('/needs-attention')).body.count).toBe(2)
  })

  it('read a full thread, and get a 404 for an unknown id and a 400 for a malformed one', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const token = await signUp(api, '9824612345')
    const { id } = (await open(api, token)).body.ticket
    const thread = (await admin(api, cookie).get(`/${id}`)).body
    expect(thread.ticket).toMatchObject({ ticketNumber: 1001, customerPhone: '+919824612345', status: 'open' })
    expect(thread.messages[0]).toMatchObject({ author: 'customer', body: report.description })
    expect((await admin(api, cookie).get('/00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await admin(api, cookie).get('/nope')).status).toBe(400)
  })

  it('reply: the first reply puts an open ticket in progress, and writes an audit entry with ids only', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const token = await signUp(api, '9824612345')
    const { id } = (await open(api, token)).body.ticket
    const response = await admin(api, cookie).post(`/${id}/messages`, { body: '  We are looking into it.  ' })
    expect(response.status).toBe(201)
    expect(response.body.ticket.status).toBe('in_progress')
    expect(response.body.messages.at(-1)).toMatchObject({ author: 'admin', body: 'We are looking into it.' })
    expect(api.audit.find(entry => entry.action === 'support_reply_sent')?.details).toEqual({ ticketId: id })
    expect((await admin(api, cookie).post(`/${id}/messages`, { body: '   ' })).status).toBe(400)
  })

  it('move a ticket only along the allowed steps, stamp resolved and closed times, and keep closed final', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const token = await signUp(api, '9824612345')
    const { id } = (await open(api, token)).body.ticket
    const staff = admin(api, cookie)
    expect((await staff.patch(`/${id}/status`, { status: 'closed' })).body.error.code).toBe('INVALID_TRANSITION')
    const resolved = await staff.patch(`/${id}/status`, { status: 'resolved' })
    expect(resolved.body.ticket).toMatchObject({ status: 'resolved' })
    expect(resolved.body.ticket.resolvedAt).not.toBeNull()
    const reopened = await staff.patch(`/${id}/status`, { status: 'in_progress' })
    expect(reopened.body.ticket.resolvedAt).toBeNull()
    await staff.patch(`/${id}/status`, { status: 'resolved' })
    const done = await staff.patch(`/${id}/status`, { status: 'closed' })
    expect(done.body.ticket.closedAt).not.toBeNull()
    expect((await staff.patch(`/${id}/status`, { status: 'in_progress' })).body.error.code).toBe('INVALID_TRANSITION')
    expect((await staff.post(`/${id}/messages`, { body: 'late reply' })).body.error.code).toBe('TICKET_CLOSED')
    expect((await staff.patch(`/${id}/status`, { status: 'weird' })).status).toBe(400)
    expect(api.audit.filter(entry => entry.action === 'support_ticket_status_changed').map(entry => (entry.details as { to: string }).to)).toEqual(['resolved', 'in_progress', 'resolved', 'closed'])
  })

  it('take a ticket as themselves and hand it back; nobody can assign someone else by name', async () => {
    const api = await createTestApi()
    const cookie = await adminCookie(api)
    const token = await signUp(api, '9824612345')
    const { id } = (await open(api, token)).body.ticket
    const staff = admin(api, cookie)
    const taken = await staff.put(`/${id}/assignee`, { assigned: true, assigneeAdminId: 'someone-else' })
    expect(taken.body.ticket).toMatchObject({ assigneeEmail: 'owner@example.com' })
    expect(taken.body.ticket.assigneeAdminId).toBe(api.admin?.id)
    expect((await staff.put(`/${id}/assignee`, { assigned: false })).body.ticket.assigneeAdminId).toBeNull()
    expect((await staff.put(`/${id}/assignee`, { assigned: 'yes' })).status).toBe(400)
  })
})
