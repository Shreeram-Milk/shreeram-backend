import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'
import { signUpByEmail } from './checkout-helpers.js'

async function adminSignedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const send = (api: TestApi, cookie: string, method: 'post' | 'put', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
const get = (api: TestApi, cookie: string, path: string) => request(api.app).get(path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN)
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

async function customer(api: TestApi, phone: string, type: 'prepaid' | 'credit', limitPaise = 0) {
  const { response, customerId: id } = await signUpByEmail(api, phone)
  const stored = api.customerAuth.customers.get(id)
  if (stored) { stored.customerType = type; stored.name = type === 'credit' ? 'Ravi Shah' : 'Asha Patel' }
  api.orders.creditLimits.set(id, limitPaise)
  return { token: response.body.token as string, id }
}
/** A credit customer who already owes Rs 500 (an opening balance entered by staff). */
async function owing(api: TestApi, cookie: string, limitPaise = 100_000, owedPaise = 50_000) {
  const c = await customer(api, '9824612345', 'credit', limitPaise)
  await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/adjustments`, { direction: 'debit', amountPaise: owedPaise, description: 'Opening balance' })
  return c
}

describe('credit accounts (admin)', () => {
  it('need a signed-in admin from the admin site, and only exist for credit customers', async () => {
    const api = await createTestApi()
    const credit = await customer(api, '9824612345', 'credit', 50_000)
    const prepaid = await customer(api, '9824612346', 'prepaid')
    expect((await request(api.app).get('/admin/credit-accounts').set('Origin', ADMIN_ORIGIN)).status).toBe(401)
    const cookie = await adminSignedIn(api)
    const foreign = await request(api.app).put(`/admin/credit-accounts/${credit.id}/limit`).set('Cookie', cookie).set('Origin', 'https://evil.example').send({ limitPaise: 1 })
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    const notCredit = await get(api, cookie, `/admin/credit-accounts/${prepaid.id}`)
    expect([notCredit.status, notCredit.body.error.code]).toEqual([409, 'NOT_A_CREDIT_ACCOUNT'])
    expect((await get(api, cookie, '/admin/credit-accounts/6f1c2d3e-0000-4000-8000-000000000000')).status).toBe(404)
    const list = await get(api, cookie, '/admin/credit-accounts')
    expect(list.body.rows.map((row: { customerId: string }) => row.customerId)).toEqual([credit.id])
  })

  it('lists credit customers with what they owe, newest debt first, and can filter to those who owe', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const a = await customer(api, '9824612345', 'credit', 100_000)
    const b = await customer(api, '9824612347', 'credit', 100_000)
    await send(api, cookie, 'post', `/admin/credit-accounts/${b.id}/adjustments`, { direction: 'debit', amountPaise: 25_000, description: 'Opening balance' })
    const all = await get(api, cookie, '/admin/credit-accounts')
    expect(all.body.rows.map((row: { customerId: string; owedPaise: number }) => [row.customerId, row.owedPaise])).toEqual([[b.id, 25_000], [a.id, 0]])
    const owingOnly = await get(api, cookie, '/admin/credit-accounts?owingOnly=true')
    expect(owingOnly.body.rows).toHaveLength(1)
    expect(owingOnly.body.rows[0]).toMatchObject({ limitPaise: 100_000, owedPaise: 25_000, remainingPaise: 75_000 })
  })

  it('sets the credit limit, and refuses a negative one', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const c = await customer(api, '9824612345', 'credit', 0)
    const set = await send(api, cookie, 'put', `/admin/credit-accounts/${c.id}/limit`, { limitPaise: 250_000 })
    expect(set.body.account).toMatchObject({ limitPaise: 250_000, remainingPaise: 250_000 })
    expect((await send(api, cookie, 'put', `/admin/credit-accounts/${c.id}/limit`, { limitPaise: -1 })).status).toBe(400)
    expect(api.audit.some(entry => entry.action === 'credit_limit_set')).toBe(true)
  })

  it('records a payment received by hand, refuses more than is owed, and keeps a ledger that adds up', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const c = await owing(api, cookie)
    const paid = await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payments`, { amountPaise: 20_000, method: 'cash', note: 'Handed over on delivery' })
    expect(paid.status).toBe(201)
    expect(paid.body.account).toMatchObject({ owedPaise: 30_000, remainingPaise: 70_000 })
    expect(api.credit.manualPayments).toEqual([expect.objectContaining({ customerId: c.id, amountPaise: 20_000, method: 'cash' })])
    const tooMuch = await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payments`, { amountPaise: 30_001, method: 'upi' })
    expect([tooMuch.status, tooMuch.body.error.code]).toEqual([409, 'PAYMENT_EXCEEDS_BALANCE'])
    expect((await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payments`, { amountPaise: 0, method: 'cash' })).status).toBe(400)
    expect((await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payments`, { amountPaise: 10, method: 'bitcoin' })).status).toBe(400)
    const ledger = await get(api, cookie, `/admin/credit-accounts/${c.id}/ledger`)
    expect(ledger.body.total).toBe(2)
    expect(ledger.body.rows.map((row: { entryType: string; direction: string; amountPaise: number; balancePaise: number }) => [row.entryType, row.direction, row.amountPaise, row.balancePaise]))
      .toEqual([['payment_received', 'credit', 20_000, 30_000], ['manual_adjustment', 'debit', 50_000, 50_000]])
  })

  it('corrects the ledger with adjustments, and will not take the balance below zero', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const c = await owing(api, cookie)
    expect((await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/adjustments`, { direction: 'credit', amountPaise: 10_000, description: 'Goodwill discount' })).body.account.owedPaise).toBe(40_000)
    const over = await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/adjustments`, { direction: 'credit', amountPaise: 40_001, description: 'Too much' })
    expect([over.status, over.body.error.code]).toEqual([409, 'ADJUSTMENT_EXCEEDS_BALANCE'])
    expect((await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/adjustments`, { direction: 'debit', amountPaise: 100, description: 'x' })).status).toBe(400)
  })
})

describe('payment requests and the customer view', () => {
  it('lets staff ask for part of what is owed, shows it to the customer, and closes it when staff record the payment', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const c = await owing(api, cookie)
    const tooBig = await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payment-requests`, { amountPaise: 50_001, note: '' })
    expect([tooBig.status, tooBig.body.error.code]).toEqual([409, 'REQUEST_EXCEEDS_BALANCE'])
    const created = await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payment-requests`, { amountPaise: 30_000, note: 'October bill' })
    expect(created.status).toBe(201)
    const mine = await request(api.app).get('/customer/credit').set(bearer(c.token))
    expect(mine.headers['cache-control']).toBe('no-store')
    expect(mine.body).toMatchObject({ account: { limitPaise: 100_000, owedPaise: 50_000, remainingPaise: 50_000 }, requests: [{ amountPaise: 30_000, note: 'October bill', status: 'open' }] })
    await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payments`, { amountPaise: 30_000, method: 'upi', paymentRequestId: created.body.request.id })
    expect((await request(api.app).get('/customer/credit').set(bearer(c.token))).body.requests).toEqual([])
  })

  it('cancels a request, only while it is open', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const c = await owing(api, cookie)
    const created = (await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payment-requests`, { amountPaise: 10_000, note: '' })).body.request
    expect((await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payment-requests/${created.id}/cancel`, {})).body.request.status).toBe('cancelled')
    expect((await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payment-requests/${created.id}/cancel`, {})).status).toBe(404)
  })

  it('lets the customer pay a request online once, which lowers what they owe', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const c = await owing(api, cookie)
    const created = (await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payment-requests`, { amountPaise: 30_000, note: '' })).body.request
    const started = await request(api.app).post(`/customer/payment-requests/${created.id}/pay`).set(bearer(c.token)).send({ idempotencyKey: 'pay-request-1' })
    expect(started.status).toBe(201)
    expect(started.body.checkout).toMatchObject({ environment: 'SANDBOX', merchantId: 'MTESTMERCHANT', token: expect.any(String) })
    // Nothing is credited until PhonePe confirms.
    expect(api.orders.ledger.filter(row => row.customerId === c.id).map(row => row.type)).toEqual(['manual_adjustment'])
    const confirmed = await request(api.app).post(`/customer/payments/${started.body.payment.merchantOrderId}/confirm`).set(bearer(c.token))
    expect(confirmed.body.payment).toMatchObject({ status: 'paid', fulfilment: 'fulfilled', purpose: 'credit_settlement' })
    expect((await request(api.app).get('/customer/credit').set(bearer(c.token))).body.account).toMatchObject({ owedPaise: 20_000 })
    expect((await request(api.app).post(`/customer/payment-requests/${created.id}/pay`).set(bearer(c.token)).send({ idempotencyKey: 'pay-request-2' })).status).toBe(404)
    expect(api.orders.ledger.filter(row => row.customerId === c.id).map(row => row.type)).toEqual(['manual_adjustment', 'payment_received'])
  })

  it('keeps one customer from paying another one\'s request, and shows a prepaid customer nothing', async () => {
    const api = await createTestApi()
    const cookie = await adminSignedIn(api)
    const c = await owing(api, cookie)
    const other = await customer(api, '9824612346', 'credit', 100_000)
    const created = (await send(api, cookie, 'post', `/admin/credit-accounts/${c.id}/payment-requests`, { amountPaise: 10_000, note: '' })).body.request
    expect((await request(api.app).post(`/customer/payment-requests/${created.id}/pay`).set(bearer(other.token)).send({ idempotencyKey: 'other-person-1' })).status).toBe(404)
    const prepaid = await customer(api, '9824612348', 'prepaid')
    expect((await request(api.app).get('/customer/credit').set(bearer(prepaid.token))).body).toEqual({ account: null, requests: [] })
    expect((await request(api.app).get('/customer/credit')).status).toBe(401)
  })
})
