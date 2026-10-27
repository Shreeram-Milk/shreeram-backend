import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { adminGet, adminSend, bearer, customerSignUp, milkOrder, shop, type Shop } from './checkout-helpers.js'
import { LATE_PAYMENT_GRACE_MS, orderWindowClosed } from '../src/modules/payments/repository.js'
import { ADMIN_ORIGIN, createTestApi, type TestApi } from './fakes.js'

const startOrderPayment = (api: TestApi, token: string, body: object) => request(api.app).post('/customer/orders/payments').set(bearer(token)).send(body)
const confirm = (api: TestApi, token: string, merchantOrderId: string) => request(api.app).post(`/customer/payments/${merchantOrderId}/confirm`).set(bearer(token))
const webhook = (api: TestApi, authorization: string | null, body: object) => {
  const call = request(api.app).post('/webhooks/phonepe')
  return (authorization === null ? call : call.set('Authorization', authorization)).send(body)
}
const completedEvent = (merchantOrderId: string, state = 'COMPLETED') => ({ event: `checkout.order.${state === 'COMPLETED' ? 'completed' : 'failed'}`, payload: { merchantOrderId, orderId: `OMO-${merchantOrderId}`, state, amount: 7000 } })
const kinds = (api: TestApi, paymentId: string) => api.payments.activity.filter(item => item.paymentId === paymentId).map(item => item.kind)

/** A prepaid customer (pays online) with milk ready to order. */
async function paying(api: TestApi): Promise<{ s: Shop; token: string; addressId: string; customerId: string }> {
  const s = await shop(api)
  const customer = await customerSignUp(api, '9824612345')
  return { s, ...customer }
}

describe('paying for an order online: payment first, order after', () => {
  it('writes no order until PhonePe confirms, then writes it exactly once however often it is confirmed', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false

    const started = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-pay-1'))
    expect(started.status).toBe(201)
    expect(started.body.checkout).toEqual({ environment: 'SANDBOX', merchantId: 'MTESTMERCHANT', providerOrderId: expect.stringMatching(/^OMO-SRM/), token: expect.any(String) })
    const { merchantOrderId } = started.body.payment
    expect(merchantOrderId).toMatch(/^SRM[0-9a-f]{32}$/)
    expect(started.body.payment).toMatchObject({ status: 'pending', amountPaise: 7000, orders: [] })
    expect(api.orders.orders).toHaveLength(0)

    // The phone says "success" but PhonePe still says pending: nothing is written.
    expect((await confirm(api, token, merchantOrderId)).body.payment).toMatchObject({ status: 'pending', orders: [] })
    expect(api.orders.orders).toHaveLength(0)

    api.phonePe.set(merchantOrderId, { state: 'COMPLETED' })
    const paid = await confirm(api, token, merchantOrderId)
    expect(paid.body.payment).toMatchObject({ status: 'paid', fulfilment: 'fulfilled' })
    expect(paid.body.payment.orders).toEqual([expect.objectContaining({ paymentMethod: 'online', paymentStatus: 'paid', totalPaise: 7000 })])

    await confirm(api, token, merchantOrderId)
    await confirm(api, token, merchantOrderId)
    expect(api.orders.orders).toHaveLength(1)
    const payment = api.payments.payments[0]
    expect(payment).toMatchObject({ status: 'paid', providerTransactionId: `TXN-${merchantOrderId}` })
    expect(kinds(api, payment?.id ?? '').filter(kind => kind === 'fulfilled')).toHaveLength(1)
    expect(api.orders.orders[0]?.paymentId).toBe(payment?.id)
  })

  it('delivers once when the phone, the webhook and the background check all confirm at the same moment', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-race'))).body.payment
    api.phonePe.set(merchantOrderId, { state: 'COMPLETED' })
    api.clock.advanceMinutes(5)
    await Promise.all([
      confirm(api, token, merchantOrderId), confirm(api, token, merchantOrderId),
      webhook(api, 'genuine-phonepe-hash', completedEvent(merchantOrderId)),
      api.paymentService.reconcile(),
    ])
    expect(api.orders.orders).toHaveLength(1)
    expect(api.payments.payments[0]).toMatchObject({ status: 'paid', fulfilment: 'fulfilled' })
  })

  it('records a failed payment with PhonePe\'s reason, writes nothing, and needs a fresh press to try again', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-fail'))).body.payment
    api.phonePe.set(merchantOrderId, { state: 'FAILED', errorCode: 'AUTHORIZATION_ERROR' })
    expect((await confirm(api, token, merchantOrderId)).body.payment).toMatchObject({ status: 'failed', failureReason: 'AUTHORIZATION_ERROR', orders: [] })
    expect(api.orders.orders).toHaveLength(0)

    const sameKey = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-fail'))
    expect([sameKey.status, sameKey.body.error.code]).toEqual([409, 'PAYMENT_ALREADY_STARTED'])
    api.phonePe.control.autoComplete = true
    const retry = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-fail-retry'))
    expect((await confirm(api, token, retry.body.payment.merchantOrderId)).body.payment.status).toBe('paid')
    expect(api.orders.orders).toHaveLength(1)
  })

  it('answers a repeated press after payment with the same orders, and never asks PhonePe for a second payment', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    const first = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-again'))
    await confirm(api, token, first.body.payment.merchantOrderId)
    const again = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-again'))
    expect(again.status).toBe(201)
    expect(again.body.checkout).toBeNull()
    expect(again.body.payment.orders).toHaveLength(1)
    expect(api.phonePe.control.createCalls).toBe(1)
    expect(api.payments.payments).toHaveLength(1)
  })

  it('tells the customer when PhonePe cannot be reached, and leaves a failed record instead of a stuck one', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.createFails = true
    const started = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-down'))
    expect([started.status, started.body.error.code]).toEqual([502, 'PAYMENT_PROVIDER_UNAVAILABLE'])
    expect(api.payments.payments[0]).toMatchObject({ status: 'failed', failureReason: 'PROVIDER_UNAVAILABLE' })
    expect(kinds(api, api.payments.payments[0]?.id ?? '')).toEqual(['started', 'provider_error', 'failed'])
    expect(api.orders.orders).toHaveLength(0)
  })

  it('keeps a payment pending (never guesses) when PhonePe does not answer the status check, and settles it later', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-timeout'))).body.payment
    api.phonePe.control.statusFails = true
    const meanwhile = await confirm(api, token, merchantOrderId)
    expect([meanwhile.status, meanwhile.body.payment.status]).toEqual([200, 'pending'])
    expect(api.orders.orders).toHaveLength(0)
    api.phonePe.control.statusFails = false
    expect((await confirm(api, token, merchantOrderId)).body.payment.status).toBe('paid')
  })

  it('never delivers when PhonePe reports a different amount: the money is kept on record and a refund is queued', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-mismatch'))).body.payment
    api.phonePe.set(merchantOrderId, { state: 'COMPLETED', reportedAmountPaise: 100 })
    expect((await confirm(api, token, merchantOrderId)).body.payment).toMatchObject({ status: 'paid', fulfilment: 'refund_due', orders: [] })
    expect(api.orders.orders).toHaveLength(0)
    const payment = api.payments.payments[0]
    expect(api.orders.adjustments).toEqual([expect.objectContaining({ type: 'refund_pending', paymentId: payment?.id, orderId: null, amountPaise: 100 })])

    // Staff refund it in PhonePe and record it: the payment shows as refunded.
    const adjustmentId = api.orders.adjustments[0]?.id
    const applied = await adminSend(api, s.cookie, 'post', `/admin/prepaid-adjustments/${adjustmentId}/apply`, { providerReference: 'PP-REF-9', note: 'Sent back' })
    expect(applied.status).toBe(200)
    expect(api.payments.payments[0]?.status).toBe('partially_refunded')
  })

  it('never half-places a checkout: if the credit part is refused after paying, nothing is written and the payment is refunded', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId, customerId } = await customerSignUp(api, '9824612345')
    const stored = api.customerAuth.customers.get(customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(customerId, 7000)
    await adminSend(api, s.cookie, 'patch', `/admin/products/${s.ghee.id}/credit-exclusion`, { excludedFromCredit: true })
    api.phonePe.control.autoComplete = false
    const mixed = { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }, { variantId: s.gheeVariant, quantity: 1 }], slots: { [s.setupKey]: s.slot }, idempotencyKey: 'key-mixed-pay' }
    const started = await startOrderPayment(api, token, mixed)
    expect(started.body.payment.amountPaise).toBe(22000)
    // Meanwhile the credit room is used up by another order.
    expect((await request(api.app).post('/customer/orders').set(bearer(token)).send(milkOrder(s, addressId, 'key-uses-credit'))).status).toBe(201)
    api.phonePe.set(started.body.payment.merchantOrderId, { state: 'COMPLETED' })
    const result = await confirm(api, token, started.body.payment.merchantOrderId)
    expect(result.body.payment).toMatchObject({ status: 'paid', fulfilment: 'refund_due', orders: [] })
    expect(api.orders.orders).toHaveLength(1)
    expect(api.orders.ledger).toHaveLength(1)
    expect(api.orders.adjustments).toEqual([expect.objectContaining({ type: 'refund_pending', amountPaise: 22000, reason: expect.stringContaining('CREDIT_LIMIT_EXCEEDED') })])
  })

  it('writes the order at the price the customer paid, even if the price changes while they are paying', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-frozen'))).body.payment
    const product = api.products.rows.find(item => item.id === s.milk.id)
    if (product?.variants[0]) product.variants[0].pricePaise = 9900
    api.phonePe.set(merchantOrderId, { state: 'COMPLETED' })
    const paid = await confirm(api, token, merchantOrderId)
    expect(paid.body.payment.orders[0]).toMatchObject({ totalPaise: 7000, items: [expect.objectContaining({ unitPricePaise: 3500 })] })
  })

  it('gives PhonePe between 5 and 15 minutes, never longer than until the order-by time', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    await startOrderPayment(api, token, milkOrder(s, addressId, 'key-window'))
    const payment = api.payments.payments[0]
    const minutes = (Date.parse(payment?.expiresAt ?? '') - api.clock.now().getTime()) / 60_000
    expect(minutes).toBe(15)
  })
})

describe('how an online payment shows to staff', () => {
  it('shows on the admin order: PhonePe references, the method and the bank reference, and the same on the payment', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-method'))).body.payment
    const paid = await confirm(api, token, merchantOrderId)
    const orderId = paid.body.payment.orders[0].id as string
    const order = (await adminGet(api, s.cookie, `/admin/orders/${orderId}`)).body.order
    expect(order.onlinePayment).toMatchObject({ merchantOrderId, providerOrderId: `OMO-${merchantOrderId}`, providerTransactionId: `TXN-${merchantOrderId}`, status: 'paid', mode: 'UPI_INTENT', instrument: 'ACCOUNT', bankReference: expect.stringMatching(/^UTR-/), paidAt: expect.any(String) })
    const payment = (await adminGet(api, s.cookie, `/admin/payments/${order.onlinePayment.id}`)).body.payment
    expect(payment.method).toMatchObject({ mode: 'UPI_INTENT', bankReference: expect.stringMatching(/^UTR-/) })
    // The customer's own view of the order does not carry staff details.
    expect((await request(api.app).get(`/customer/orders/${orderId}`).set(bearer(token))).body.order).not.toHaveProperty('onlinePayment')
  })

  it('shows no online payment on a credit order', async () => {
    const api = await createTestApi()
    const { s, token, addressId, customerId } = await paying(api)
    const stored = api.customerAuth.customers.get(customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(customerId, 100_000)
    const placed = await request(api.app).post('/customer/orders').set(bearer(token)).send(milkOrder(s, addressId, 'key-credit-show'))
    expect((await adminGet(api, s.cookie, `/admin/orders/${placed.body.orders[0].id}`)).body.order.onlinePayment).toBeNull()
  })
})

describe('what can and cannot start or see a payment', () => {
  it('refuses to place an online order without paying, and refuses a payment for a credit-only cart', async () => {
    const api = await createTestApi()
    const { s, token, addressId, customerId } = await paying(api)
    const direct = await request(api.app).post('/customer/orders').set(bearer(token)).send(milkOrder(s, addressId, 'key-no-pay'))
    expect([direct.status, direct.body.error.code, direct.body.error.details]).toEqual([409, 'PAYMENT_REQUIRED', { amountPaise: 7000 }])
    expect(api.orders.orders).toHaveLength(0)
    const stored = api.customerAuth.customers.get(customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(customerId, 100_000)
    const nothingToPay = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-credit-only'))
    expect([nothingToPay.status, nothingToPay.body.error.code]).toEqual([409, 'NO_PAYMENT_NEEDED'])
    expect(api.payments.payments).toHaveLength(0)
  })

  it('applies every checkout check before PhonePe is asked: price changed, window not offered, nothing deliverable', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    const stale = await startOrderPayment(api, token, { ...milkOrder(s, addressId, 'key-stale'), expectedTotalPaise: 1 })
    expect(stale.body.error.code).toBe('PRICE_CHANGED')
    const wrongWindow = await startOrderPayment(api, token, { ...milkOrder(s, addressId, 'key-badwin'), slots: { [s.setupKey]: '6f1c2d3e-0000-4000-8000-000000000000' } })
    expect(wrongWindow.body.error.code).toBe('SLOT_NOT_AVAILABLE')
    api.deliveryAnswers.delete(s.milk.id)
    const nowhere = await startOrderPayment(api, token, milkOrder(s, addressId, 'key-nowhere'))
    expect(nowhere.body.error.code).toBe('NOT_DELIVERABLE')
    expect(api.phonePe.control.createCalls).toBe(0)
    expect(api.payments.payments).toHaveLength(0)
  })

  it('lets only the payer ask about a payment', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-mine'))).body.payment
    const other = await customerSignUp(api, '9824612399')
    expect((await confirm(api, other.token, merchantOrderId)).status).toBe(404)
    expect((await request(api.app).post(`/customer/payments/${merchantOrderId}/confirm`)).status).toBe(401)
    expect((await confirm(api, token, 'not-a-reference')).status).toBe(400)
    expect((await confirm(api, token, `SRM${'0'.repeat(32)}`)).status).toBe(404)
  })
})

describe('the PhonePe webhook', () => {
  it('ignores a webhook without the right Authorization, and never believes the body: PhonePe is asked', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-hook'))).body.payment
    expect((await webhook(api, null, completedEvent(merchantOrderId))).status).toBe(401)
    expect((await webhook(api, 'forged', completedEvent(merchantOrderId))).status).toBe(401)
    // Genuine header, body says COMPLETED, PhonePe's status API says still pending: nothing is written.
    expect((await webhook(api, 'genuine-phonepe-hash', completedEvent(merchantOrderId))).status).toBe(200)
    expect(api.orders.orders).toHaveLength(0)
    api.phonePe.set(merchantOrderId, { state: 'COMPLETED' })
    expect((await webhook(api, 'genuine-phonepe-hash', { ...completedEvent(merchantOrderId), event: 'checkout.order.completed.retry' })).status).toBe(200)
    expect(api.orders.orders).toHaveLength(1)
  })

  it('processes a repeated webhook once, and asks PhonePe to send it again when PhonePe could not be reached', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-hook-2'))).body.payment
    api.phonePe.set(merchantOrderId, { state: 'COMPLETED' })
    api.phonePe.control.statusFails = true
    expect((await webhook(api, 'genuine-phonepe-hash', completedEvent(merchantOrderId))).status).toBe(503)
    api.phonePe.control.statusFails = false
    expect((await webhook(api, 'genuine-phonepe-hash', completedEvent(merchantOrderId))).status).toBe(200)
    const calls = api.phonePe.control.statusCalls
    expect((await webhook(api, 'genuine-phonepe-hash', completedEvent(merchantOrderId))).status).toBe(200)
    expect(api.phonePe.control.statusCalls).toBe(calls)
    expect(api.orders.orders).toHaveLength(1)
    expect((await webhook(api, 'genuine-phonepe-hash', completedEvent(`SRM${'f'.repeat(32)}`))).status).toBe(200)
  })
})

describe('the background check', () => {
  it('settles payments the phone never confirmed, leaves very new ones alone, and closes ones PhonePe never resolves', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const forgotten = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-forgotten'))).body.payment.merchantOrderId
    const abandoned = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-abandoned'))).body.payment.merchantOrderId
    api.phonePe.set(forgotten, { state: 'COMPLETED' })
    expect(await api.paymentService.reconcile()).toEqual({ checked: 0, failures: 0 })
    api.clock.advanceMinutes(3)
    expect(await api.paymentService.reconcile()).toEqual({ checked: 2, failures: 0 })
    expect(api.orders.orders).toHaveLength(1)
    expect(api.payments.payments.find(item => item.merchantOrderId === abandoned)?.status).toBe('pending')
    api.clock.advanceMinutes(30)
    await api.paymentService.reconcile()
    expect(api.payments.payments.find(item => item.merchantOrderId === abandoned)).toMatchObject({ status: 'failed', failureReason: 'EXPIRED' })
  })
})

describe('paying a payment request online', () => {
  async function owingCustomer(api: TestApi, cookie: string) {
    const c = await customerSignUp(api, '9824612345')
    const stored = api.customerAuth.customers.get(c.customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(c.customerId, 100_000)
    await adminSend(api, cookie, 'post', `/admin/credit-accounts/${c.customerId}/adjustments`, { direction: 'debit', amountPaise: 50_000, description: 'Opening balance' })
    return c
  }

  it('credits only what is still owed when the payment lands, and queues a refund for the rest', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const c = await owingCustomer(api, s.cookie)
    api.phonePe.control.autoComplete = false
    const created = (await adminSend(api, s.cookie, 'post', `/admin/credit-accounts/${c.customerId}/payment-requests`, { amountPaise: 30_000, note: '' })).body.request
    const started = await request(api.app).post(`/customer/payment-requests/${created.id}/pay`).set(bearer(c.token)).send({ idempotencyKey: 'pay-req-race' })
    expect(started.status).toBe(201)
    // While the customer is on PhonePe's screen, staff record ₹400 cash: only ₹100 is now owed.
    await adminSend(api, s.cookie, 'post', `/admin/credit-accounts/${c.customerId}/payments`, { amountPaise: 40_000, method: 'cash' })
    api.phonePe.set(started.body.payment.merchantOrderId, { state: 'COMPLETED' })
    const done = await request(api.app).post(`/customer/payments/${started.body.payment.merchantOrderId}/confirm`).set(bearer(c.token))
    expect(done.body.payment).toMatchObject({ status: 'paid', fulfilment: 'fulfilled' })
    expect((await request(api.app).get('/customer/credit').set(bearer(c.token))).body.account.owedPaise).toBe(0)
    expect(api.orders.adjustments).toEqual([expect.objectContaining({ type: 'refund_pending', amountPaise: 20_000 })])
  })

  it('needs a request key and an open request the customer owes', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const c = await owingCustomer(api, s.cookie)
    const created = (await adminSend(api, s.cookie, 'post', `/admin/credit-accounts/${c.customerId}/payment-requests`, { amountPaise: 10_000, note: '' })).body.request
    expect((await request(api.app).post(`/customer/payment-requests/${created.id}/pay`).set(bearer(c.token)).send({})).status).toBe(400)
    await adminSend(api, s.cookie, 'post', `/admin/credit-accounts/${c.customerId}/payment-requests/${created.id}/cancel`, {})
    expect((await request(api.app).post(`/customer/payment-requests/${created.id}/pay`).set(bearer(c.token)).send({ idempotencyKey: 'closed-request' })).status).toBe(404)
  })
})

describe('staff view of online payments', () => {
  it('lists payments with their step-by-step history, lets staff ask PhonePe again, and is closed to everyone else', async () => {
    const api = await createTestApi()
    const { s, token, addressId } = await paying(api)
    api.phonePe.control.autoComplete = false
    const { merchantOrderId } = (await startOrderPayment(api, token, milkOrder(s, addressId, 'key-staff'))).body.payment
    expect((await request(api.app).get('/admin/payments').set('Origin', ADMIN_ORIGIN)).status).toBe(401)
    const list = await adminGet(api, s.cookie, '/admin/payments?status=pending')
    expect(list.body).toMatchObject({ total: 1, rows: [expect.objectContaining({ merchantOrderId, status: 'pending', amountPaise: 7000, customerPhone: '+919824612345' })] })
    expect(list.body.rows[0]).not.toHaveProperty('snapshot')
    const id = list.body.rows[0].id as string
    api.phonePe.set(merchantOrderId, { state: 'COMPLETED' })
    const checked = await adminSend(api, s.cookie, 'post', `/admin/payments/${id}/check`, {})
    expect(checked.body.payment).toMatchObject({ status: 'paid', fulfilment: 'fulfilled', orders: [expect.objectContaining({ totalPaise: 7000 })] })
    expect(checked.body.payment.activity.map((item: { kind: string }) => item.kind)).toEqual(['started', 'provider_order_created', 'paid', 'fulfilled'])
    expect((await adminGet(api, s.cookie, `/admin/payments?search=${merchantOrderId.slice(0, 12)}`)).body.total).toBe(1)
    expect((await adminGet(api, s.cookie, '/admin/payments/not-an-id')).status).toBe(400)
  })
})

describe('a payment that arrives after the order-by time', () => {
  const closes = '2026-10-24T15:30:00.000Z'
  const closesAt = Date.parse(closes)
  const local = (orderBy: string | null) => [{ deliveryMethod: 'local_delivery', orderBy }]
  const at = (ms: number) => new Date(closesAt + ms)

  it('is refused when the customer began paying after the order-by time', () => {
    expect(orderWindowClosed(local(closes), at(0), at(60_000))).toBe(true)
    expect(orderWindowClosed(local(closes), at(5_000), at(10_000))).toBe(true)
  })

  it('is still accepted when paying began in time and the confirmation is only a little late', () => {
    expect(orderWindowClosed(local(closes), at(-60_000), at(120_000))).toBe(false)
    expect(orderWindowClosed(local(closes), at(-1_000), at(LATE_PAYMENT_GRACE_MS - 1_000))).toBe(false)
  })

  it('is refused when paying began in time but the confirmation is later than the grace period', () => {
    expect(orderWindowClosed(local(closes), at(-60_000), at(LATE_PAYMENT_GRACE_MS))).toBe(true)
    expect(orderWindowClosed(local(closes), at(-60_000), at(LATE_PAYMENT_GRACE_MS + 60_000))).toBe(true)
  })

  it('does not apply to orders with no order-by time or to courier orders', () => {
    expect(orderWindowClosed(local(null), at(-60_000), at(10 * 60 * 60_000))).toBe(false)
    expect(orderWindowClosed([{ deliveryMethod: 'shipping', orderBy: '2026-10-24T00:00:00.000Z' }], at(-60_000), at(10 * 60 * 60_000))).toBe(false)
  })
})
