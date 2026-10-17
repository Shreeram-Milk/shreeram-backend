import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { discountFor, distributeDiscount } from '../src/modules/offers/rules.js'
import { adminGet, adminSend, bearer, customerSignUp, milkOrder, place, quote, shop } from './checkout-helpers.js'
import { createTestApi, type TestApi } from './fakes.js'

const percentOffer = { title: '20% off', kind: 'percent', percent: 20, maxDiscountPaise: 10000, minOrderPaise: 10000 }
const flatOffer = { title: 'Rs 100 off', kind: 'flat', flatPaise: 10000, minOrderPaise: 20000 }

async function offerOf(api: TestApi, cookie: string, body: object) {
  const response = await adminSend(api, cookie, 'post', '/admin/offers', body)
  expect(response.status).toBe(201)
  return response.body.offer as { id: string }
}

describe('offer rules', () => {
  it('takes a percent off, capped, and never more than the part of the cart that counts', () => {
    expect(discountFor({ kind: 'percent', percent: 20, flatPaise: null, maxDiscountPaise: null }, 12345)).toBe(2469)
    expect(discountFor({ kind: 'percent', percent: 20, flatPaise: null, maxDiscountPaise: 10000 }, 100000)).toBe(10000)
    expect(discountFor({ kind: 'flat', percent: null, flatPaise: 50000, maxDiscountPaise: null }, 30000)).toBe(30000)
    expect(discountFor({ kind: 'flat', percent: null, flatPaise: 10000, maxDiscountPaise: null }, 0)).toBe(0)
  })
  it('shares a discount across orders in whole paise that add up exactly', () => {
    const parts = distributeDiscount(1001, [3333, 3333, 3334])
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(1001)
    expect(distributeDiscount(100, [0, 0])).toEqual([0, 0])
    expect(distributeDiscount(0, [500, 500])).toEqual([0, 0])
  })
})

describe('managing offers', () => {
  it('needs a signed-in admin, saves an offer, upper-cases its code and refuses a repeated code', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/offers')).status).toBe(401)
    const s = await shop(api)
    const created = await adminSend(api, s.cookie, 'post', '/admin/offers', { ...percentOffer, code: 'welcome20' })
    expect(created.body.offer).toMatchObject({ title: '20% off', kind: 'percent', code: 'WELCOME20', status: 'active' })
    const again = await adminSend(api, s.cookie, 'post', '/admin/offers', { ...flatOffer, code: 'WELCOME20' })
    expect([again.status, again.body.error.code]).toEqual([409, 'OFFER_CODE_TAKEN'])
    expect((await adminGet(api, s.cookie, '/admin/offers')).body.offers).toHaveLength(1)
  })
  it('refuses offers that make no sense', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const send = (body: object) => adminSend(api, s.cookie, 'post', '/admin/offers', body)
    expect((await send({ title: 'x', kind: 'percent' })).status).toBe(400)
    expect((await send({ title: 'x', kind: 'percent', percent: 100 })).status).toBe(400)
    expect((await send({ title: 'x', kind: 'flat', flatPaise: 100, maxDiscountPaise: 50 })).status).toBe(400)
    expect((await send({ title: 'x', kind: 'percent', percent: 10, scope: 'products' })).status).toBe(400)
    expect((await send({ title: 'x', kind: 'percent', percent: 10, startsOn: '2026-10-10', endsOn: '2026-10-01' })).status).toBe(400)
    expect((await send({ title: 'x', kind: 'percent', percent: 10, code: 'no spaces' })).status).toBe(400)
  })
  it('lists to customers only offers that are live today', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    await offerOf(api, s.cookie, { ...percentOffer, title: 'Live' })
    await offerOf(api, s.cookie, { ...percentOffer, title: 'Later', startsOn: '2027-01-01' })
    const off = await offerOf(api, s.cookie, { ...percentOffer, title: 'Off' })
    await adminSend(api, s.cookie, 'patch', `/admin/offers/${off.id}/status`, { status: 'inactive' })
    const titles = (await request(api.app).get('/public/offers')).body.offers.map((offer: { title: string }) => offer.title)
    expect(titles).toEqual(['Live'])
  })
})

describe('offers at checkout', () => {
  it('applies the best automatic offer, shows it in the quote, and charges exactly the discounted total', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await offerOf(api, s.cookie, percentOffer)
    await offerOf(api, s.cookie, flatOffer)
    const lines = [{ variantId: s.milkLiter, quantity: 4 }] // Rs 260
    const result = await quote(api, token, { addressId, lines })
    expect(result.body.quote.problems).toEqual([])
    // 20% of Rs 260 = Rs 52; flat Rs 100 beats it.
    expect(result.body.quote.offer).toMatchObject({ title: 'Rs 100 off', discountPaise: 10000 })
    expect(result.body.quote.totalPaise).toBe(26000 - 10000)
    const placed = await place(api, token, { addressId, lines, slots: { [s.setupKey]: s.slot }, idempotencyKey: 'key-offer-1', expectedTotalPaise: 16000 })
    expect(placed.status).toBe(201)
    expect(placed.body.orders[0]).toMatchObject({ subtotalPaise: 26000, discountPaise: 10000, totalPaise: 16000, offerTitle: 'Rs 100 off' })
    expect(api.orders.payments[0]).toMatchObject({ amountPaise: 16000 })
  })

  it('applies nothing when the minimum order is not reached, and a typed code tells the customer why', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await offerOf(api, s.cookie, { ...percentOffer, code: 'SAVE20', minOrderPaise: 50000 })
    const without = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }], slots: { [s.setupKey]: s.slot } })
    expect(without.body.quote.offer).toBeNull()
    const typed = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }], slots: { [s.setupKey]: s.slot }, offerCode: 'save20' })
    expect(typed.body.quote.problems[0]).toMatchObject({ code: 'OFFER_MIN_ORDER', details: { minOrderPaise: 50000, shortByPaise: 43000 } })
    const wrong = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }], slots: { [s.setupKey]: s.slot }, offerCode: 'NOPE' })
    expect(wrong.body.quote.problems[0].code).toBe('OFFER_CODE_INVALID')
    const refused = await place(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }], slots: { [s.setupKey]: s.slot }, idempotencyKey: 'key-offer-bad', offerCode: 'NOPE' })
    expect([refused.status, refused.body.error.code]).toEqual([409, 'OFFER_CODE_INVALID'])
  })

  it('a code offer never applies by itself, and a code applies only that offer', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await offerOf(api, s.cookie, { ...flatOffer, title: 'Auto flat' })
    await offerOf(api, s.cookie, { ...percentOffer, title: 'Code percent', code: 'PCT', minOrderPaise: 0, maxDiscountPaise: null, percent: 50 })
    const lines = [{ variantId: s.milkLiter, quantity: 4 }]
    expect((await quote(api, token, { addressId, lines })).body.quote.offer.title).toBe('Auto flat')
    expect((await quote(api, token, { addressId, lines, offerCode: 'pct' })).body.quote.offer).toMatchObject({ title: 'Code percent', discountPaise: 13000 })
  })

  it('only counts the chosen products when an offer is limited to some products', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await offerOf(api, s.cookie, { title: 'Ghee 10%', kind: 'percent', percent: 10, scope: 'products', productIds: [s.ghee.id] })
    const milkOnly = await quote(api, token, { addressId, lines: [{ variantId: s.milkLiter, quantity: 2 }] })
    expect(milkOnly.body.quote.offer).toBeNull()
    const both = await quote(api, token, { addressId, lines: [{ variantId: s.milkLiter, quantity: 2 }, { variantId: s.gheeVariant, quantity: 1 }] })
    expect(both.body.quote.offer).toMatchObject({ discountPaise: 2200 })
  })

  it('shares the discount across the orders of one checkout so the parts add up to the offer', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await offerOf(api, s.cookie, { title: 'Rs 100 off', kind: 'flat', flatPaise: 10001 })
    const result = await quote(api, token, { addressId, lines: [{ variantId: s.milkLiter, quantity: 2 }, { variantId: s.gheeVariant, quantity: 1 }], slots: { [s.setupKey]: s.slot } })
    const parts = result.body.quote.orders.map((order: { discountPaise: number }) => order.discountPaise)
    expect(parts).toHaveLength(2)
    expect(parts.reduce((sum: number, part: number) => sum + part, 0)).toBe(10001)
    expect(result.body.quote.totalPaise).toBe(13000 + 22000 - 10001)
  })

  it('never makes the whole checkout free', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await offerOf(api, s.cookie, { title: 'Huge', kind: 'flat', flatPaise: 9_000_000 })
    const result = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 1 }] })
    expect(result.body.quote.totalPaise).toBe(100)
  })

  it('honours the total limit and the per-customer limit, and repeating the same request does not use the offer twice', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const first = await customerSignUp(api, '9824612345')
    const second = await customerSignUp(api, '9824612346')
    await offerOf(api, s.cookie, { ...flatOffer, minOrderPaise: 0, flatPaise: 1000, perCustomerLimit: 1, totalLimit: 2, code: 'ONCE' })
    const order = (key: string) => ({ ...milkOrder(s, first.addressId, key), offerCode: 'ONCE' })
    expect((await place(api, first.token, order('key-use-1'))).status).toBe(201)
    // The phone repeating the same payment request gets the same payment back, and the offer is not used again.
    const repeated = await request(api.app).post('/customer/orders/payments').set(bearer(first.token)).send(order('key-use-1'))
    expect(repeated.status).toBeLessThan(300)
    expect(api.offerStore.redemptions).toHaveLength(1)
    const again = await place(api, first.token, order('key-use-2'))
    expect([again.status, again.body.error.code]).toEqual([409, 'OFFER_ALREADY_USED'])
    const other = await place(api, second.token, { ...milkOrder(s, second.addressId, 'key-use-3'), offerCode: 'ONCE' })
    expect(other.status).toBe(201)
    expect(api.offerStore.redemptions).toHaveLength(2)
  })

  it('refuses an offer switched off after the customer saw it', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const offer = await offerOf(api, s.cookie, { ...flatOffer, minOrderPaise: 0, code: 'GONE' })
    await adminSend(api, s.cookie, 'patch', `/admin/offers/${offer.id}/status`, { status: 'inactive' })
    const refused = await place(api, token, { ...milkOrder(s, addressId, 'key-gone'), offerCode: 'GONE' })
    expect([refused.status, refused.body.error.code]).toEqual([409, 'OFFER_NOT_LIVE'])
  })

  it('a cancelled order returns exactly what was paid', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    await offerOf(api, s.cookie, { ...flatOffer, minOrderPaise: 0, flatPaise: 1000 })
    const placed = await place(api, token, milkOrder(s, addressId, 'key-cancel'))
    expect(placed.body.orders[0]).toMatchObject({ discountPaise: 1000, totalPaise: 6000 })
    const cancelled = await request(api.app).post(`/customer/orders/${placed.body.orders[0].id}/cancel`).set(bearer(token)).send({})
    expect(cancelled.status).toBe(200)
    expect(api.orders.ledger.length + api.orders.payments.length).toBeGreaterThan(0)
    expect(api.orders.payments[0]).toMatchObject({ amountPaise: 6000 })
  })
})

describe('free gifts', () => {
  const giftOffer = (s: Awaited<ReturnType<typeof shop>>, extra: object = {}) => ({ title: 'Free ghee with milk', kind: 'free_gift', productIds: [s.milk.id], giftVariantId: s.gheeVariant, ...extra })

  it('adds the gift at no charge to the order that earned it, and the gift costs full price when bought alone', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    api.offerStore.giftsOnSale.set(s.gheeVariant, 22000)
    await offerOf(api, s.cookie, giftOffer(s))
    const lines = [{ variantId: s.milkVariant, quantity: 2 }]
    const result = await quote(api, token, { addressId, lines })
    expect(result.body.quote.offer).toMatchObject({ title: 'Free ghee with milk', discountPaise: 0 })
    expect(result.body.quote.orders[0].items).toEqual([
      expect.objectContaining({ productName: 'Cow Milk', lineTotalPaise: 7000 }),
      expect.objectContaining({ productName: 'Cow Ghee', unitPricePaise: 0, lineTotalPaise: 0, isGift: true }),
    ])
    expect(result.body.quote.totalPaise).toBe(7000)
    const placed = await place(api, token, { addressId, lines, slots: { [s.setupKey]: s.slot }, idempotencyKey: 'key-gift-1' })
    expect(placed.status).toBe(201)
    expect(placed.body.orders[0]).toMatchObject({ totalPaise: 7000, offerTitle: 'Free ghee with milk' })
    expect(placed.body.orders[0].items.map((item: { productName: string; isGift: boolean }) => [item.productName, item.isGift])).toEqual([['Cow Milk', false], ['Cow Ghee', true]])
    // Bought on its own, the ghee is charged in full and no offer applies.
    const alone = await quote(api, token, { addressId, lines: [{ variantId: s.gheeVariant, quantity: 1 }] })
    expect(alone.body.quote.offer).toBeNull()
    expect(alone.body.quote.totalPaise).toBe(22000)
  })

  it('does not offer the gift when the gift product is switched off', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    api.offerStore.giftsOnSale.set(s.gheeVariant, 22000)
    await offerOf(api, s.cookie, giftOffer(s, { code: 'GHEE' }))
    expect((await request(api.app).get('/public/offers')).body.offers).toHaveLength(1)
    // The gift is then switched off: nothing is listed and the code does not work.
    api.offerStore.giftsOnSale.delete(s.gheeVariant)
    expect((await request(api.app).get('/public/offers')).body.offers).toEqual([])
    const typed = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2 }], offerCode: 'GHEE' })
    expect(typed.body.quote.problems[0].code).toBe('OFFER_NOT_FOR_THIS')
    expect(typed.body.quote.offer).toBeNull()
  })

  it('refuses to save an active gift offer whose gift is not on sale', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const refused = await adminSend(api, s.cookie, 'post', '/admin/offers', giftOffer(s))
    expect([refused.status, refused.body.error.code]).toEqual([409, 'OFFER_GIFT_UNAVAILABLE'])
  })
})
