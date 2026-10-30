import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, createTestApi, type TestApi } from './fakes.js'
import { adminGet, adminSend, bearer, customerSignUp, milkOrder, place, quote, shop } from './checkout-helpers.js'

describe('pricing and placing an order', () => {
  it('needs a signed-in customer', async () => {
    const api = await createTestApi()
    expect((await request(api.app).post('/customer/orders/quote').send({})).status).toBe(401)
    expect((await request(api.app).get('/customer/orders')).status).toBe(401)
  })

  it('prices the cart from stored prices, shows the windows with their order-by time, and asks for a window before it can be placed', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    // With two windows the customer must choose; with only one it is chosen for them.
    const served = api.deliveryAnswers.get(s.milk.id)
    if (!served?.served) throw new Error('shop should serve milk')
    const evening = { slotId: 'evening-slot', name: 'Evening', startTime: '17:00', endTime: '19:00', earliestDate: '2026-10-10', orderBy: '2026-10-10T05:30:00.000Z', cancelBy: '2026-10-10T05:30:00.000Z' }
    api.deliveryAnswers.set(s.milk.id, { ...served, slots: [...served.slots, evening] })
    const result = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }, { variantId: s.milkLiter, quantity: 1 }] })
    expect(result.status).toBe(200)
    expect(result.body.quote.totalPaise).toBe(2 * 3500 + 6500)
    expect(result.body.quote.orders).toHaveLength(1)
    expect(result.body.quote.orders[0]).toMatchObject({ deliveryMethod: 'local_delivery', payment: 'online', selectedSlotId: null })
    expect(result.body.quote.orders[0].slots[0]).toMatchObject({ name: 'Morning', earliestDate: '2026-10-11', orderBy: '2026-10-10T15:30:00.000Z' })
    expect(result.body.quote.problems.map((problem: { code: string }) => problem.code)).toContain('SLOT_REQUIRED')
    const refused = await place(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }], slots: {}, idempotencyKey: 'key-slot-missing' })
    expect([refused.status, refused.body.error.code]).toEqual([409, 'SLOT_REQUIRED'])
    api.deliveryAnswers.set(s.milk.id, served)
    const only = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }] })
    expect(only.body.quote.orders[0]).toMatchObject({ selectedSlotId: s.slot, deliveryDate: '2026-10-11' })
    expect(only.body.quote.problems).toEqual([])
    const mismatched = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }], slots: { [s.setupKey]: 'a6f1c2d3-0000-4000-8000-000000000001' } })
    expect(mismatched.body.quote.problems.map((problem: { code: string }) => problem.code)).toEqual(['SLOT_NOT_AVAILABLE'])
  })

  it('lets the customer change the delivery window on the review screen after picking another one on the product page', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const served = api.deliveryAnswers.get(s.milk.id)
    if (!served?.served) throw new Error('shop should serve milk')
    const evening = { slotId: 'a6f1c2d3-0000-4000-8000-0000000000e1', name: 'Evening', startTime: '17:00', endTime: '19:00', earliestDate: '2026-10-10', orderBy: '2026-10-10T05:30:00.000Z', cancelBy: '2026-10-10T05:30:00.000Z' }
    api.deliveryAnswers.set(s.milk.id, { ...served, slots: [...served.slots, evening] })
    const lines = [{ variantId: s.milkVariant, quantity: 2, slotId: s.slot }]
    const fromProductPage = await quote(api, token, { addressId, lines })
    expect(fromProductPage.body.quote.orders[0].selectedSlotId).toBe(s.slot)
    // The review screen sends its choice under the key of the order it was shown in (which includes the window from the product page).
    const changed = await quote(api, token, { addressId, lines, slots: { [fromProductPage.body.quote.orders[0].key]: evening.slotId } })
    expect(changed.body.quote.orders[0].selectedSlotId).toBe(evening.slotId)
    expect(changed.body.quote.problems).toEqual([])
  })

  it('places an order the server priced itself, with the delivery date, window and address, only after its payment is confirmed', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const placed = await place(api, token, { ...milkOrder(s, addressId, 'key-one-first'), price: 1, totalPaise: 1 })
    expect(placed.status).toBe(201)
    const [order] = placed.body.orders
    expect(order).toMatchObject({ status: 'placed', deliveryMethod: 'local_delivery', deliveryDate: '2026-10-11', totalPaise: 7000, paymentMethod: 'online', paymentStatus: 'paid', pinCode: '382010', recipientName: 'Asha Patel' })
    expect(order.orderNumber).toMatch(/^SRM-\d+$/)
    expect(order.slot).toMatchObject({ name: 'Morning', startTime: '05:00' })
    expect(order.items).toEqual([expect.objectContaining({ productName: 'Cow Milk', variantName: '500 ml', unitPricePaise: 3500, quantity: 2, lineTotalPaise: 7000 })])
    expect(api.orders.payments).toHaveLength(1)
    expect(api.orders.payments[0]).toMatchObject({ status: 'paid', fulfilment: 'fulfilled', amountPaise: 7000, providerTransactionId: expect.stringMatching(/^TXN-/) })
  })

  it('never makes a second order when the same request is repeated', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const first = await place(api, token, milkOrder(s, addressId, 'key-repeat-1'))
    const again = await place(api, token, milkOrder(s, addressId, 'key-repeat-1'))
    expect(again.body.orders[0].id).toBe(first.body.orders[0].id)
    expect(api.orders.orders).toHaveLength(1)
    expect(api.orders.payments).toHaveLength(1)
    const other = await place(api, token, milkOrder(s, addressId, 'key-repeat-2'))
    expect(other.body.orders[0].id).not.toBe(first.body.orders[0].id)
  })

  it('splits a cart into one order per delivery setup', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const placed = await place(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 1 }, { variantId: s.gheeVariant, quantity: 1 }], slots: { [s.setupKey]: s.slot }, idempotencyKey: 'key-two-orders' })
    expect(placed.status).toBe(201)
    expect(placed.body.orders).toHaveLength(2)
    expect(placed.body.orders.map((order: { deliveryMethod: string }) => order.deliveryMethod).sort()).toEqual(['local_delivery', 'shipping'])
    const courier = placed.body.orders.find((order: { deliveryMethod: string }) => order.deliveryMethod === 'shipping')
    expect(courier).toMatchObject({ slot: null, totalPaise: 22000 })
  })

  it('refuses items that are gone, products that cannot reach the address, and a slot that is not offered', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await adminSend(api, s.cookie, 'patch', `/admin/products/${s.ghee.id}/status`, { status: 'inactive' })
    const gone = await place(api, token, { addressId, lines: [{ variantId: s.gheeVariant, quantity: 1 }], slots: {}, idempotencyKey: 'key-gone-item' })
    expect([gone.status, gone.body.error.code]).toEqual([409, 'ITEM_UNAVAILABLE'])
    api.deliveryAnswers.delete(s.milk.id)
    const far = await place(api, token, milkOrder(s, addressId, 'key-not-served'))
    expect([far.status, far.body.error.code]).toEqual([409, 'NOT_DELIVERABLE'])
    api.deliveryAnswers.set(s.milk.id, { served: true, deliveryMethod: 'local_delivery', locality: '', slots: [] })
    const noWindow = await place(api, token, milkOrder(s, addressId, 'key-no-window'))
    expect([noWindow.status, noWindow.body.error.code]).toEqual([409, 'SLOT_NOT_AVAILABLE'])
    expect(api.orders.orders).toHaveLength(0)
  })

  it('orders only what can be delivered when part of the cart cannot reach the address, and lists the rest', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612346')
    api.deliveryAnswers.delete(s.milk.id)
    const lines = [{ variantId: s.milkVariant, quantity: 2 }, { variantId: s.gheeVariant, quantity: 1 }]
    const priced = await quote(api, token, { addressId, lines })
    expect(priced.status).toBe(200)
    expect(priced.body.quote.unavailable.map((item: { variantId: string }) => item.variantId)).toEqual([s.milkVariant])
    expect(priced.body.quote.orders).toHaveLength(1)
    expect(priced.body.quote.totalPaise).toBe(22000)
    const placed = await place(api, token, { addressId, lines, slots: {}, idempotencyKey: 'key-mixed-cart', expectedTotalPaise: 22000 })
    expect(placed.status).toBe(201)
    expect(placed.body.orders).toHaveLength(1)
    expect(placed.body.orders[0].items.map((item: { variantId: string }) => item.variantId)).toEqual([s.gheeVariant])
  })

  it('uses the window picked on the product page, and lets the review screen override it', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612347')
    const withPreference = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 1, slotId: s.slot }] })
    expect(withPreference.body.quote.orders[0].selectedSlotId).toBe(s.slot)
    expect(withPreference.body.quote.problems).toEqual([])
    const notOffered = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 1, slotId: '11111111-1111-4111-8111-111111111111' }] })
    expect(notOffered.status).toBe(200)
    // A window that is not offered is never swapped for another one: the customer must choose again.
    expect(notOffered.body.quote.orders[0].selectedSlotId).toBeNull()
    expect(notOffered.body.quote.problems.map((problem: { code: string }) => problem.code)).toContain('SLOT_NOT_AVAILABLE')
  })

  it('rejects another customer\'s address and a malformed request', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const mine = await customerSignUp(api, '9824612345')
    const theirs = await customerSignUp(api, '9824612346')
    const stolen = await place(api, mine.token, milkOrder(s, theirs.addressId, 'key-stolen'))
    expect([stolen.status, stolen.body.error.code]).toEqual([404, 'ADDRESS_NOT_FOUND'])
    const bad = await place(api, mine.token, { addressId: 'nope', lines: [], idempotencyKey: 'x' })
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
  })
})

describe('safety checks when placing and cancelling', () => {
  it('refuses to charge a price the customer did not see, and shows the new total', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const stale = await place(api, token, { ...milkOrder(s, addressId, 'key-price-1'), expectedTotalPaise: 6000 })
    expect([stale.status, stale.body.error.code]).toEqual([409, 'PRICE_CHANGED'])
    expect(stale.body.error.details).toEqual({ totalPaise: 7000 })
    expect(api.orders.orders).toHaveLength(0)
    expect(api.orders.payments).toHaveLength(0)
    const fresh = await place(api, token, { ...milkOrder(s, addressId, 'key-price-2'), expectedTotalPaise: 7000 })
    expect(fresh.status).toBe(201)
  })

  it('copies the customer doorstep wishes onto the order', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await request(api.app).put('/customer/doorstep-instructions').set(bearer(token)).send({ dropLocation: 'milk-box', handoff: 'leave-at-door', noDoorbell: true, noCall: true, notifyAfterDelivery: true, additionalInstructions: 'Dog in the garden' })
    const order = (await place(api, token, milkOrder(s, addressId, 'key-doorstep'))).body.orders[0]
    expect(order.doorstepNote).toBe('Drop: Milk box. Leave at the door. Do not ring the bell. Do not call. Dog in the garden')
  })

  it('lets a customer cancel a courier order until it is sent', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const order = (await place(api, token, { addressId, lines: [{ variantId: s.gheeVariant, quantity: 1 }], slots: {}, idempotencyKey: 'key-courier-cancel' })).body.orders[0]
    expect((await request(api.app).get(`/customer/orders/${order.id}`).set(bearer(token))).body.order.canCancel).toBe(true)
    expect((await request(api.app).post(`/customer/orders/${order.id}/cancel`).set(bearer(token)).send({})).body.order.status).toBe('cancelled')
  })

  it('does not let a customer cancel an order staff have already sent', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const order = (await place(api, token, milkOrder(s, addressId, 'key-sent-first'))).body.orders[0]
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'out_for_delivery' })
    const late = await request(api.app).post(`/customer/orders/${order.id}/cancel`).set(bearer(token)).send({})
    expect([late.status, late.body.error.code]).toEqual([409, 'CANCEL_NOT_ALLOWED'])
    expect(api.orders.orders.find(item => item.id === order.id)?.status).toBe('out_for_delivery')
  })
})

describe('credit customers', () => {
  async function creditCustomer(api: TestApi, limitPaise: number) {
    const customer = await customerSignUp(api, '9824612345')
    const stored = api.customerAuth.customers.get(customer.customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(customer.customerId, limitPaise)
    return customer
  }

  it('orders on credit up to the limit, adds the amount to what is owed, and refuses the order that would go over', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId, customerId } = await creditCustomer(api, 10_500)
    const first = await place(api, token, milkOrder(s, addressId, 'key-credit-1'))
    expect(first.body.orders[0]).toMatchObject({ paymentMethod: 'credit', paymentStatus: 'unpaid', totalPaise: 7000 })
    expect(api.orders.ledger).toEqual([expect.objectContaining({ customerId, type: 'order_charge', direction: 'debit', amountPaise: 7000 })])
    expect(api.orders.payments).toHaveLength(0)
    const over = await place(api, token, milkOrder(s, addressId, 'key-credit-2'))
    expect([over.status, over.body.error.code]).toEqual([409, 'CREDIT_LIMIT_EXCEEDED'])
    expect(over.body.error.details).toMatchObject({ limitPaise: 10_500, owedPaise: 7000, neededPaise: 7000 })
    expect(api.orders.orders).toHaveLength(1)
    const exact = await place(api, token, milkOrder(s, addressId, 'key-credit-3', 1))
    expect(exact.status).toBe(201)
    const stillOk = await quote(api, token, milkOrder(s, addressId, 'ignored', 1))
    expect(stillOk.body.quote.credit).toMatchObject({ limitPaise: 10_500, owedPaise: 10_500, remainingPaise: 0 })
    expect(stillOk.body.quote.problems.map((problem: { code: string }) => problem.code)).toContain('CREDIT_LIMIT_EXCEEDED')
  })

  it('pays online for an order that holds a product marked not available on credit', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    await adminSend(api, s.cookie, 'patch', `/admin/products/${s.milk.id}/credit-exclusion`, { excludedFromCredit: true })
    const placed = await place(api, token, milkOrder(s, addressId, 'key-excluded'))
    expect(placed.body.orders[0]).toMatchObject({ paymentMethod: 'online', paymentStatus: 'paid' })
    expect(api.orders.ledger).toHaveLength(0)
    const shown = await quote(api, token, milkOrder(s, addressId, 'ignored'))
    expect(shown.body.quote.orders[0]).toMatchObject({ payment: 'online', paymentNote: 'excluded_product' })
  })

  it('keeps credit and online orders in one cart apart', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    await adminSend(api, s.cookie, 'patch', `/admin/products/${s.ghee.id}/credit-exclusion`, { excludedFromCredit: true })
    const placed = await place(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 1 }, { variantId: s.gheeVariant, quantity: 1 }], slots: { [s.setupKey]: s.slot }, idempotencyKey: 'key-mixed-cart' })
    expect(placed.body.orders.map((order: { paymentMethod: string }) => order.paymentMethod).sort()).toEqual(['credit', 'online'])
    expect(api.orders.ledger).toHaveLength(1)
    expect(api.orders.payments).toHaveLength(1)
  })

  it('does not give credit to a prepaid customer, whatever the phone says', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId, customerId } = await customerSignUp(api, '9824612345')
    api.orders.creditLimits.set(customerId, 1_000_000)
    const placed = await place(api, token, milkOrder(s, addressId, 'key-prepaid'))
    expect(placed.body.orders[0].paymentMethod).toBe('online')
  })
})

describe('cancelling and the status steps', () => {
  it('lets a customer cancel before the order-by time, reverses the credit charge, and refuses once the time has passed', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId, customerId } = await customerSignUp(api, '9824612345')
    const stored = api.customerAuth.customers.get(customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(customerId, 50_000)
    const first = (await place(api, token, milkOrder(s, addressId, 'key-cancel-1'))).body.orders[0]
    const second = (await place(api, token, milkOrder(s, addressId, 'key-cancel-2'))).body.orders[0]
    const read = await request(api.app).get(`/customer/orders/${first.id}`).set(bearer(token))
    expect(read.body.order.canCancel).toBe(true)
    const cancelled = await request(api.app).post(`/customer/orders/${first.id}/cancel`).set(bearer(token)).send({ reason: 'Changed my mind' })
    expect(cancelled.body.order).toMatchObject({ status: 'cancelled', cancelReason: 'Changed my mind' })
    expect(api.orders.ledger.filter(row => row.orderId === first.id).map(row => row.type)).toEqual(['order_charge', 'order_refund'])
    expect((await request(api.app).post(`/customer/orders/${first.id}/cancel`).set(bearer(token)).send({})).body.error.code).toBe('CANCEL_NOT_ALLOWED')
    api.clock.advanceMinutes(10 * 60)
    const late = await request(api.app).post(`/customer/orders/${second.id}/cancel`).set(bearer(token)).send({})
    expect([late.status, late.body.error.code]).toEqual([409, 'CANCEL_NOT_ALLOWED'])
  })

  it('notes a refund for the admin when an online-paid order is cancelled, once', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const order = (await place(api, token, milkOrder(s, addressId, 'key-online-cancel'))).body.orders[0]
    await request(api.app).post(`/customer/orders/${order.id}/cancel`).set(bearer(token)).send({})
    expect(api.orders.adjustments).toEqual([expect.objectContaining({ orderId: order.id, type: 'refund_pending', amountPaise: 7000 })])
  })

  it('keeps one customer\'s orders away from another', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const mine = await customerSignUp(api, '9824612345')
    const theirs = await customerSignUp(api, '9824612346')
    const order = (await place(api, mine.token, milkOrder(s, mine.addressId, 'key-private'))).body.orders[0]
    expect((await request(api.app).get(`/customer/orders/${order.id}`).set(bearer(theirs.token))).status).toBe(404)
    expect((await request(api.app).post(`/customer/orders/${order.id}/cancel`).set(bearer(theirs.token)).send({})).status).toBe(404)
    expect((await request(api.app).get('/customer/orders').set(bearer(theirs.token))).body.orders).toEqual([])
    expect((await request(api.app).get('/customer/orders').set(bearer(mine.token))).body.orders).toHaveLength(1)
  })

  it('lets staff move an order along only by legal steps; a missed delivery keeps its charge until staff return the money', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId, customerId } = await customerSignUp(api, '9824612345')
    const stored = api.customerAuth.customers.get(customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(customerId, 50_000)
    const order = (await place(api, token, milkOrder(s, addressId, 'key-staff-steps'))).body.orders[0]
    expect((await request(api.app).get('/admin/orders')).status).toBe(401)
    const list = await adminGet(api, s.cookie, '/admin/orders?status=placed')
    expect(list.body.total).toBe(1)
    expect(list.body.rows[0]).toMatchObject({ id: order.id, customerPhone: '+919824612345' })
    const skip = await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'delivered' })
    expect([skip.status, skip.body.error.code]).toEqual([409, 'INVALID_STATUS_STEP'])
    expect((await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'out_for_delivery' })).body.order.status).toBe('out_for_delivery')
    const missed = await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'missed', note: 'Nobody home' })
    expect(missed.body.order.status).toBe('missed')
    expect(api.orders.ledger.map(row => row.type)).toEqual(['order_charge'])
    expect((await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'delivered' })).status).toBe(409)
    expect(api.audit.filter(entry => entry.action === 'order_status_changed')).toHaveLength(2)
    const bad = await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'placed' })
    expect(bad.status).toBe(400)

    const returned = await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/return-money`, { reason: 'Our van broke down' })
    expect(returned.status).toBe(200)
    expect(returned.body.order.moneyReturnedAt).toEqual(expect.any(String))
    expect(api.orders.ledger.map(row => row.type)).toEqual(['order_charge', 'order_refund'])
    const twice = await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/return-money`, { reason: 'Our van broke down' })
    expect([twice.status, twice.body.error.code]).toEqual([409, 'MONEY_ALREADY_RETURNED'])
    expect(api.orders.ledger).toHaveLength(2)
  })

  it('refuses to return money before an order is missed or delivered, and makes a refund to send for an online one', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const order = (await place(api, token, milkOrder(s, addressId, 'key-online-missed'))).body.orders[0]
    const early = await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/return-money`, { reason: 'Too soon' })
    expect([early.status, early.body.error.code]).toEqual([409, 'RETURN_NOT_ALLOWED'])
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'out_for_delivery' })
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'missed' })
    expect(api.orders.adjustments).toHaveLength(0)
    expect((await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/return-money`, { reason: 'Customer was away' })).status).toBe(200)
    expect(api.orders.adjustments).toEqual([expect.objectContaining({ type: 'refund_pending', status: 'pending', amountPaise: order.totalPaise, orderId: order.id })])
  })

  it('filters orders by product and payment, and counts each status for the day summary', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const first = (await place(api, token, milkOrder(s, addressId, 'key-filter-1'))).body.orders[0]
    await place(api, token, milkOrder(s, addressId, 'key-filter-2'))
    await adminSend(api, s.cookie, 'post', `/admin/orders/${first.id}/status`, { status: 'cancelled', note: 'Changed mind' })
    const listed = await adminGet(api, s.cookie, `/admin/orders?productId=${s.milk.id}&payment=online&source=one_time`)
    expect(listed.body.total).toBe(2)
    expect(listed.body.counts).toEqual({ placed: 1, out_for_delivery: 0, delivered: 0, missed: 0, cancelled: 1 })
    // Type counts ignore the type filter, so each type tab keeps its own number.
    expect(listed.body.typeCounts).toEqual({ one_time: 2, subscription: 0, trial: 0 })
    expect((await adminGet(api, s.cookie, '/admin/orders?source=subscription')).body.typeCounts.one_time).toBe(2)
    const placedOnly = await adminGet(api, s.cookie, '/admin/orders?status=placed')
    expect([placedOnly.body.total, placedOnly.body.counts.cancelled]).toEqual([1, 1])
    expect((await adminGet(api, s.cookie, '/admin/orders?payment=credit')).body.total).toBe(0)
    expect((await adminGet(api, s.cookie, `/admin/orders?productId=${s.ghee.id}`)).body.total).toBe(0)
    expect((await adminGet(api, s.cookie, '/admin/orders?source=trial')).body.total).toBe(0)
  })

  it('moves many orders a step at once and reports the ones that could not move', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const first = (await place(api, token, milkOrder(s, addressId, 'key-bulk-1'))).body.orders[0]
    const second = (await place(api, token, milkOrder(s, addressId, 'key-bulk-2'))).body.orders[0]
    await adminSend(api, s.cookie, 'post', `/admin/orders/${second.id}/status`, { status: 'cancelled', note: 'Changed mind' })
    const result = await adminSend(api, s.cookie, 'post', '/admin/orders/bulk-status', { orderIds: [first.id, second.id], status: 'out_for_delivery' })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ updated: 1, failed: [{ orderId: second.id, code: 'INVALID_STATUS_STEP' }] })
    expect(api.orders.orders.find(item => item.id === first.id)?.status).toBe('out_for_delivery')
    expect((await adminSend(api, s.cookie, 'post', '/admin/orders/bulk-status', { orderIds: [first.id], status: 'cancelled' })).status).toBe(400)
  })

  it('keeps a courier and tracking link only on courier orders, and only real web links', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const order = (await place(api, token, milkOrder(s, addressId, 'key-courier'))).body.orders[0]
    const local = await adminSend(api, s.cookie, 'put', `/admin/orders/${order.id}/courier`, { courierName: 'Delhivery', trackingUrl: 'https://track.example/1' })
    expect([local.status, local.body.error.code]).toEqual([409, 'NOT_A_COURIER_ORDER'])
    const stored = api.orders.orders.find(item => item.id === order.id)
    if (stored) stored.deliveryMethod = 'shipping'
    const bad = await adminSend(api, s.cookie, 'put', `/admin/orders/${order.id}/courier`, { courierName: 'Delhivery', trackingUrl: 'javascript:alert(1)' })
    expect(bad.status).toBe(400)
    const saved = await adminSend(api, s.cookie, 'put', `/admin/orders/${order.id}/courier`, { courierName: 'Delhivery', trackingUrl: 'https://track.example/1' })
    expect(saved.body.order).toMatchObject({ courierName: 'Delhivery', trackingUrl: 'https://track.example/1' })
  })
})

describe('refunds and prepaid adjustments (admin)', () => {
  it('shows the refund a cancelled online order needs, and records it once the admin has sent it in PhonePe', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const order = (await place(api, token, milkOrder(s, addressId, 'key-refund-flow'))).body.orders[0]
    expect((await request(api.app).get('/admin/prepaid-adjustments').set('Origin', ADMIN_ORIGIN)).status).toBe(401)
    await request(api.app).post(`/customer/orders/${order.id}/cancel`).set(bearer(token)).send({})
    const pending = await adminGet(api, s.cookie, '/admin/prepaid-adjustments?status=pending')
    expect(pending.body.total).toBe(1)
    expect(pending.body.rows[0]).toMatchObject({ type: 'refund_pending', status: 'pending', amountPaise: 7000, orderNumber: order.orderNumber, customerName: expect.any(String) })
    const id = pending.body.rows[0].id as string
    const applied = await adminSend(api, s.cookie, 'post', `/admin/prepaid-adjustments/${id}/apply`, { providerReference: 'PP-REFUND-1', note: 'Sent from the PhonePe dashboard' })
    expect(applied.body.adjustment.status).toBe('applied')
    expect(api.adjustments.refunds).toEqual([expect.objectContaining({ orderId: order.id, amountPaise: 7000, providerReference: 'PP-REFUND-1' })])
    expect(api.orders.orders.find(item => item.id === order.id)?.paymentStatus).toBe('refunded')
    const again = await adminSend(api, s.cookie, 'post', `/admin/prepaid-adjustments/${id}/apply`, {})
    expect([again.status, again.body.error.code]).toEqual([409, 'ADJUSTMENT_NOT_PENDING'])
    expect((await adminSend(api, s.cookie, 'post', `/admin/prepaid-adjustments/${id}/cancel`, {})).status).toBe(404)
    expect(api.audit.map(entry => entry.action)).toContain('prepaid_adjustment_applied')
  })

  it('adds a manual adjustment for a customer, checks it, and can cancel one that is still pending', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { customerId } = await customerSignUp(api, '9824612345')
    const created = await adminSend(api, s.cookie, 'post', '/admin/prepaid-adjustments', { customerId, type: 'account_credit', amountPaise: 5000, reason: 'Late delivery goodwill' })
    expect(created.status).toBe(201)
    expect(created.body.adjustment).toMatchObject({ type: 'account_credit', status: 'pending', amountPaise: 5000, reason: 'Late delivery goodwill' })
    expect((await adminSend(api, s.cookie, 'post', '/admin/prepaid-adjustments', { customerId, type: 'carry_forward', amountPaise: 5000, reason: 'not allowed by hand' })).status).toBe(400)
    expect((await adminSend(api, s.cookie, 'post', '/admin/prepaid-adjustments', { customerId, type: 'account_credit', amountPaise: 0, reason: 'zero' })).status).toBe(400)
    expect((await adminSend(api, s.cookie, 'post', '/admin/prepaid-adjustments', { customerId: '6f1c2d3e-0000-4000-8000-000000000000', type: 'account_credit', amountPaise: 100, reason: 'nobody' })).status).toBe(404)
    const cancelled = await adminSend(api, s.cookie, 'post', `/admin/prepaid-adjustments/${created.body.adjustment.id}/cancel`, {})
    expect(cancelled.body.adjustment.status).toBe('cancelled')
  })
})
