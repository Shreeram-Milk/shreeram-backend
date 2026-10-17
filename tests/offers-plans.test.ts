import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { unusedPaidPaise } from '../src/modules/subscriptions/rules.js'
import { adminSend, bearer, customerSignUp, shop } from './checkout-helpers.js'
import { createTestApi, type TestApi } from './fakes.js'

/** The shop, a daily rule offering 3 or 5 deliveries, and a 2-day trial on the milk (same set-up as the subscription tests). */
async function plansShop(api: TestApi) {
  const s = await shop(api)
  const rule = (await adminSend(api, s.cookie, 'post', '/admin/subscription-rules', { name: 'Daily', systemType: 'daily', lengthOptions: [5, 3], minDays: 3, maxDays: 20 })).body.subscriptionRule
  const trial = (await adminSend(api, s.cookie, 'post', '/admin/trial-plans', { name: '2-day trial', durationDays: 2 })).body.trialPlan.id as string
  const milk = api.products.rows.find(product => product.id === s.milk.id)
  if (milk) Object.assign(milk, { purchaseMethods: ['buy_once', 'subscription', 'trial'], subscriptionRuleIds: [rule.id], trialPlanIds: [trial] })
  const condition = { dayRelation: 'previous_day' as const, cutoffTime: '21:00' }
  api.slotRuleAnswers.set(s.milk.id, {
    served: true, deliveryMethod: 'local_delivery',
    slots: [{ slotId: s.slot, name: 'Morning', startTime: '05:00', endTime: '07:00', earliestDate: '2026-10-11', orderBy: null, cancelBy: '2026-10-10T15:30:00.000Z', condition }],
  })
  return { ...s, ruleId: rule.id as string, trialId: trial }
}
type PlansShop = Awaited<ReturnType<typeof plansShop>>

async function creditCustomer(api: TestApi) {
  const customer = await customerSignUp(api, '9824612345')
  const stored = api.customerAuth.customers.get(customer.customerId)
  if (stored) stored.customerType = 'credit'
  api.orders.creditLimits.set(customer.customerId, 1_000_000)
  return customer
}

const draft = (s: PlansShop, addressId: string, extra: object = {}) => ({ kind: 'subscription', variantId: s.milkVariant, ruleId: s.ruleId, deliveries: 3, startDate: '2026-10-11', addressId, lines: [{ slotId: s.slot, quantity: 1 }], ...extra })
const quotePlan = (api: TestApi, token: string, body: object) => request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send(body)
const subscribe = (api: TestApi, token: string, body: object) => request(api.app).post('/customer/subscriptions').set(bearer(token)).send({ idempotencyKey: `key-${Math.random()}`, ...body })
async function offer(api: TestApi, s: PlansShop, body: object) {
  const response = await adminSend(api, s.cookie, 'post', '/admin/offers', body)
  expect(response.status).toBe(201)
  return response.body.offer as { id: string }
}
const planPercent = { title: '10% off plans', kind: 'percent', percent: 10, appliesOneTime: false, appliesSubscription: true }

describe('offers on plans', () => {
  it('takes the discount off the plan total and spreads it over the deliveries so the charges add up exactly', async () => {
    const api = await createTestApi()
    const s = await plansShop(api)
    const { token, addressId } = await creditCustomer(api)
    await offer(api, s, planPercent)
    const quoted = await quotePlan(api, token, draft(s, addressId))
    expect(quoted.body.quote).toMatchObject({ subtotalPaise: 10500, discountPaise: 1050, totalPaise: 9450, offer: { title: '10% off plans', gift: null }, offerProblem: null })
    const started = await subscribe(api, token, { ...draft(s, addressId), expectedTotalPaise: 9450 })
    expect(started.status).toBe(201)
    expect(started.body.subscription).toMatchObject({ offerTitle: '10% off plans', discountPaise: 1050, totalPaise: 9450 })
    const made = api.orders.orders.filter(order => order.subscriptionId === started.body.subscription.id)
    expect(made).toHaveLength(3)
    expect(made.reduce((sum, order) => sum + order.totalPaise, 0)).toBe(9450)
    expect(made.every(order => order.offerTitle === '10% off plans')).toBe(true)
    expect(api.orders.ledger.reduce((sum, row) => sum + row.amountPaise, 0)).toBe(9450)
    expect(api.offerStore.redemptions).toHaveLength(1)
  })

  it('only applies a plan offer to the kind of purchase it is for, and to long enough plans', async () => {
    const api = await createTestApi()
    const s = await plansShop(api)
    const { token, addressId } = await creditCustomer(api)
    await offer(api, s, { ...planPercent, minPlanDays: 5 })
    expect((await quotePlan(api, token, draft(s, addressId))).body.quote.offer).toBeNull()
    expect((await quotePlan(api, token, draft(s, addressId, { deliveries: 5 }))).body.quote.offer).toMatchObject({ title: '10% off plans' })
    const trial = await quotePlan(api, token, { kind: 'trial', variantId: s.milkVariant, trialPlanId: s.trialId, startDate: '2026-10-11', addressId, lines: [{ slotId: s.slot, quantity: 1 }] })
    expect(trial.body.quote.offer).toBeNull()
  })

  it('sends a free gift with the first delivery only, and moves it to the next delivery when the first is skipped', async () => {
    const api = await createTestApi()
    const s = await plansShop(api)
    const { token, addressId } = await creditCustomer(api)
    api.offerStore.giftsOnSale.set(s.gheeVariant, 22000)
    await offer(api, s, { title: 'Free ghee with a plan', kind: 'free_gift', productIds: [s.milk.id], giftVariantId: s.gheeVariant, appliesOneTime: false, appliesSubscription: true, appliesTrial: true, code: 'GHEEPLAN' })
    const quoted = await quotePlan(api, token, draft(s, addressId, { offerCode: 'gheeplan' }))
    expect(quoted.body.quote).toMatchObject({ totalPaise: 10500, discountPaise: 0, offer: { gift: { productName: 'Cow Ghee', quantity: 1 } } })
    const started = await subscribe(api, token, draft(s, addressId, { offerCode: 'GHEEPLAN' }))
    expect(started.status).toBe(201)
    expect(started.body.subscription.gift).toMatchObject({ productName: 'Cow Ghee' })
    const giftOrders = () => api.orders.orders.filter(order => order.subscriptionId === started.body.subscription.id && order.status !== 'cancelled' && order.items.some(item => item.isGift))
    const dates = () => giftOrders().map(order => order.deliveryDate)
    expect(dates()).toEqual(['2026-10-11'])
    expect(giftOrders()[0]?.items.find(item => item.isGift)).toMatchObject({ unitPricePaise: 0, lineTotalPaise: 0 })
    // The customer skips the first day: the gift is not lost, it goes with the next delivery.
    const lineId = started.body.subscription.lines[0].id
    const skipped = await request(api.app).post(`/customer/subscriptions/${started.body.subscription.id}/skip`).set(bearer(token)).send({ lineId, date: '2026-10-11' })
    expect(skipped.status).toBe(200)
    await api.subscriptionService.syncNow(started.body.subscription.id)
    expect(dates()).toEqual(['2026-10-12'])
  })

  it('refunds a cancelled plan exactly what was paid for the unused deliveries', () => {
    // 3 deliveries of Rs 35, Rs 10.50 off in all: after 1 delivery, 2 are unused and carry 2/3 of the discount.
    expect(unusedPaidPaise(3500, 3, [{ quantity: 1, used: 1 }], 1050)).toBe(7000 - 700)
    expect(unusedPaidPaise(3500, 3, [{ quantity: 1, used: 0 }], 1050)).toBe(10500 - 1050)
    expect(unusedPaidPaise(3500, 3, [{ quantity: 1, used: 3 }], 1050)).toBe(0)
  })
})
