import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { adminGet, adminSend, adminSignedIn, bearer, customerSignUp, milkOrder, shop } from './checkout-helpers.js'
import { createTestApi, type TestApi } from './fakes.js'

const wallet = (api: TestApi, token: string) => request(api.app).get('/customer/wallet').set(bearer(token))
const topUp = (api: TestApi, token: string, amountPaise: number, key: string) => request(api.app).post('/customer/wallet/top-ups').set(bearer(token)).send({ amountPaise, idempotencyKey: key })
const confirm = (api: TestApi, token: string, merchantOrderId: string) => request(api.app).post(`/customer/payments/${merchantOrderId}/confirm`).set(bearer(token))
const askRefund = (api: TestApi, token: string, key: string) => request(api.app).post('/customer/wallet/refund-requests').set(bearer(token)).send({ idempotencyKey: key })
const placeWithWallet = (api: TestApi, token: string, body: object) => request(api.app).post('/customer/orders').set(bearer(token)).send({ ...body, payWith: 'wallet' })

/** A prepaid customer who added ₹500 with PhonePe (confirmed). */
async function funded(api: TestApi, phone = '9824612345') {
  const customer = await customerSignUp(api, phone)
  const started = await topUp(api, customer.token, 50_000, `top-${phone}`)
  expect(started.status).toBe(201)
  await confirm(api, customer.token, started.body.payment.merchantOrderId)
  return customer
}

describe('adding money to the wallet', () => {
  it('adds money only once PhonePe confirms, and only once however often it is confirmed', async () => {
    const api = await createTestApi()
    const { token } = await customerSignUp(api, '9824612345')
    api.phonePe.control.autoComplete = false
    const started = await topUp(api, token, 50_000, 'top-once')
    expect(started.status).toBe(201)
    const { merchantOrderId } = started.body.payment
    expect((await wallet(api, token)).body.wallet).toMatchObject({ enabled: true, balancePaise: 0 })

    api.phonePe.set(merchantOrderId, { state: 'COMPLETED' })
    await Promise.all([confirm(api, token, merchantOrderId), confirm(api, token, merchantOrderId), api.paymentService.reconcile()])
    await confirm(api, token, merchantOrderId)
    expect((await wallet(api, token)).body.wallet).toMatchObject({ balancePaise: 50_000, roomPaise: 950_000 })
    expect(api.orders.wallet.filter(entry => entry.type === 'top_up')).toHaveLength(1)
  })

  it('refuses less than ₹100, more than the wallet can hold, and credit customers', async () => {
    const api = await createTestApi()
    const { token, customerId } = await funded(api)
    expect((await topUp(api, token, 5_000, 'too-small')).status).toBe(400)
    const over = await topUp(api, token, 960_000, 'too-big-1')
    expect(over.status).toBe(409)
    expect(over.body.error).toMatchObject({ code: 'WALLET_LIMIT', details: { roomPaise: 950_000 } })

    const customer = api.customerAuth.customers.get(customerId)
    if (customer) customer.customerType = 'credit'
    expect((await topUp(api, token, 20_000, 'credit-customer')).body.error.code).toBe('WALLET_NOT_AVAILABLE')
    expect((await wallet(api, token)).body.wallet).toMatchObject({ enabled: false, balancePaise: 50_000 })
  })
})

describe('paying for orders from the wallet', () => {
  it('takes the order total from the wallet and puts it back, once, when the order is cancelled', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await funded(api)
    const placed = await placeWithWallet(api, token, milkOrder(s, addressId, 'wallet-order-1'))
    expect(placed.status).toBe(201)
    expect(placed.body.orders).toEqual([expect.objectContaining({ paymentMethod: 'wallet', paymentStatus: 'paid', totalPaise: 7000 })])
    expect((await wallet(api, token)).body.wallet.balancePaise).toBe(43_000)

    // The same press again finds the same order and charges nothing more.
    expect((await placeWithWallet(api, token, milkOrder(s, addressId, 'wallet-order-1'))).body.orders).toHaveLength(1)
    expect((await wallet(api, token)).body.wallet.balancePaise).toBe(43_000)

    const orderId = placed.body.orders[0].id as string
    expect((await request(api.app).post(`/customer/orders/${orderId}/cancel`).set(bearer(token)).send({ reason: 'Changed my mind' })).status).toBe(200)
    expect((await wallet(api, token)).body.wallet.balancePaise).toBe(50_000)
    expect(api.orders.wallet.filter(entry => entry.type === 'order_return')).toHaveLength(1)
    expect(api.orders.adjustments).toHaveLength(0)
  })

  it('refuses an order the wallet cannot cover and changes nothing', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const refused = await placeWithWallet(api, token, milkOrder(s, addressId, 'empty-wallet'))
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatchObject({ code: 'WALLET_BALANCE_LOW', details: { balancePaise: 0, neededPaise: 7000 } })
    expect(api.orders.orders).toHaveLength(0)
  })

  it('lets staff return a missed order\'s money to the wallet, once', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await funded(api)
    const orderId = (await placeWithWallet(api, token, milkOrder(s, addressId, 'missed-order'))).body.orders[0].id as string
    const cookie = await adminSignedIn(api)
    expect((await adminSend(api, cookie, 'post', `/admin/orders/${orderId}/status`, { status: 'missed', note: '' })).status).toBe(200)
    expect((await wallet(api, token)).body.wallet.balancePaise).toBe(43_000)
    expect((await adminSend(api, cookie, 'post', `/admin/orders/${orderId}/return-money`, { reason: 'Nobody at home' })).status).toBe(200)
    expect((await wallet(api, token)).body.wallet.balancePaise).toBe(50_000)
    expect((await adminSend(api, cookie, 'post', `/admin/orders/${orderId}/return-money`, { reason: 'Again' })).body.error.code).toBe('MONEY_ALREADY_RETURNED')
  })
})

describe('refunds', () => {
  it('sets the whole balance aside, allows one open request, and staff mark it sent with the PhonePe reference', async () => {
    const api = await createTestApi()
    const { token } = await funded(api)
    const asked = await askRefund(api, token, 'refund-key-1')
    expect(asked.status).toBe(201)
    expect(asked.body.request).toMatchObject({ amountPaise: 50_000, status: 'requested' })
    expect((await askRefund(api, token, 'refund-key-1')).body.request.id).toBe(asked.body.request.id)
    expect((await askRefund(api, token, 'refund-key-2')).body.error.code).toBe('REFUND_ALREADY_REQUESTED')
    expect((await wallet(api, token)).body.wallet).toMatchObject({ balancePaise: 0, openRefund: { amountPaise: 50_000 } })

    const cookie = await adminSignedIn(api)
    const queue = await adminGet(api, cookie, '/admin/wallet/refund-requests?status=requested')
    expect(queue.body.items).toHaveLength(1)
    const detail = await adminGet(api, cookie, `/admin/wallet/refund-requests/${asked.body.request.id}`)
    expect(detail.body.request.topUps).toEqual([expect.objectContaining({ amountPaise: 50_000 })])
    expect((await adminSend(api, cookie, 'post', `/admin/wallet/refund-requests/${asked.body.request.id}/sent`, { providerReference: '' })).status).toBe(400)
    const sent = await adminSend(api, cookie, 'post', `/admin/wallet/refund-requests/${asked.body.request.id}/sent`, { providerReference: 'PPRF123' })
    expect(sent.body.request).toMatchObject({ status: 'sent', providerReference: 'PPRF123' })
    expect((await adminSend(api, cookie, 'post', `/admin/wallet/refund-requests/${asked.body.request.id}/cancel`, { note: 'Too late' })).body.error.code).toBe('REFUND_NOT_OPEN')
    expect((await wallet(api, token)).body.wallet).toMatchObject({ balancePaise: 0, openRefund: null })
  })

  it('puts the money back in the wallet when staff cancel a request', async () => {
    const api = await createTestApi()
    const { token } = await funded(api)
    const id = (await askRefund(api, token, 'refund-cancel')).body.request.id as string
    const cookie = await adminSignedIn(api)
    expect((await adminSend(api, cookie, 'post', `/admin/wallet/refund-requests/${id}/cancel`, { note: 'Customer asked to keep it' })).body.request.status).toBe('cancelled')
    expect((await wallet(api, token)).body.wallet).toMatchObject({ balancePaise: 50_000, openRefund: null })
  })

  it('refuses a refund of an empty wallet', async () => {
    const api = await createTestApi()
    const { token } = await customerSignUp(api, '9824612345')
    expect((await askRefund(api, token, 'refund-empty')).body.error.code).toBe('WALLET_EMPTY')
  })
})

describe('staff corrections', () => {
  it('needs a reason and never takes a wallet below zero', async () => {
    const api = await createTestApi()
    const { token, customerId } = await funded(api)
    const cookie = await adminSignedIn(api)
    expect((await adminSend(api, cookie, 'post', `/admin/wallet/customers/${customerId}/adjustments`, { direction: 'credit', amountPaise: 1000, reason: '' })).status).toBe(400)
    expect((await adminSend(api, cookie, 'post', `/admin/wallet/customers/${customerId}/adjustments`, { direction: 'debit', amountPaise: 60_000, reason: 'Too much' })).body.error.code).toBe('WALLET_BALANCE_LOW')
    expect((await adminSend(api, cookie, 'post', `/admin/wallet/customers/${customerId}/adjustments`, { direction: 'credit', amountPaise: 1000, reason: 'Goodwill' })).body.wallet.balancePaise).toBe(51_000)
    const history = await request(api.app).get('/customer/wallet/entries').set(bearer(token))
    expect(history.body.items.map((entry: { type: string }) => entry.type)).toEqual(['manual_adjustment', 'top_up'])
  })
})
