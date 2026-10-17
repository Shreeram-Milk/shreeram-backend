import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { adminGet, adminSend, bearer, customerSignUp, milkOrder, place, shop } from './checkout-helpers.js'
import { createTestApi, type TestApi } from './fakes.js'

/** The shop, plus an Evening slot, a daily rule offering 3 or 5 deliveries and a 2-day trial on the milk. */
async function subscribableShop(api: TestApi) {
  const s = await shop(api)
  const evening = (await adminSend(api, s.cookie, 'post', '/admin/delivery-slots', { name: 'Evening', startTime: '17:00', endTime: '19:00' })).body.slot.id as string
  const rule = (await adminSend(api, s.cookie, 'post', '/admin/subscription-rules', { name: 'Daily', systemType: 'daily', lengthOptions: [5, 3], minDays: 3, maxDays: 20 })).body.subscriptionRule
  expect(rule.lengthOptions).toEqual([3, 5])
  const trial = (await adminSend(api, s.cookie, 'post', '/admin/trial-plans', { name: '2-day trial', durationDays: 2 })).body.trialPlan.id as string
  const milk = api.products.rows.find(product => product.id === s.milk.id)
  if (milk) Object.assign(milk, { purchaseMethods: ['buy_once', 'subscription', 'trial'], subscriptionRuleIds: [rule.id], trialPlanIds: [trial] })
  const condition = { dayRelation: 'previous_day' as const, cutoffTime: '21:00' }
  api.slotRuleAnswers.set(s.milk.id, {
    served: true, deliveryMethod: 'local_delivery',
    slots: [
      { slotId: s.slot, name: 'Morning', startTime: '05:00', endTime: '07:00', earliestDate: '2026-10-11', orderBy: null, cancelBy: '2026-10-10T15:30:00.000Z', condition },
      { slotId: evening, name: 'Evening', startTime: '17:00', endTime: '19:00', earliestDate: '2026-10-11', orderBy: null, cancelBy: '2026-10-10T15:30:00.000Z', condition },
    ],
  })
  return { ...s, evening, ruleId: rule.id as string, trialId: trial }
}

async function creditCustomer(api: TestApi, limitPaise: number) {
  const customer = await customerSignUp(api, '9824612345')
  const stored = api.customerAuth.customers.get(customer.customerId)
  if (stored) stored.customerType = 'credit'
  api.orders.creditLimits.set(customer.customerId, limitPaise)
  return customer
}

type Shop = Awaited<ReturnType<typeof subscribableShop>>
const draft = (s: Shop, addressId: string, extra: object = {}) => ({
  kind: 'subscription', variantId: s.milkVariant, ruleId: s.ruleId, deliveries: 3, startDate: '2026-10-11', addressId, lines: [{ slotId: s.slot, quantity: 1 }], ...extra,
})
/** The same draft without its number of deliveries, so a test can send a last day instead. */
const withoutLength = ({ deliveries: _count, ...rest }: ReturnType<typeof draft>) => rest
const subscribe = (api: TestApi, token: string, body: object) => request(api.app).post('/customer/subscriptions').set(bearer(token)).send({ idempotencyKey: `key-${Math.random()}`, ...body })

describe('starting a subscription', () => {
  it('prices every slot and delivery at the frozen price, and refuses lengths, dates and slots that are not offered', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const quoted = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send(draft(s, addressId, { lines: [{ slotId: s.slot, quantity: 1 }, { slotId: s.evening, quantity: 2 }] }))
    expect(quoted.status).toBe(200)
    expect(quoted.body.quote).toMatchObject({ totalPaise: 3500 * 3 * 3, endDate: '2026-10-13', paymentMethod: 'credit', earliestStartDate: '2026-10-11' })
    expect(quoted.body.quote.lines.map((line: { slotName: string; linePaise: number }) => [line.slotName, line.linePaise])).toEqual([['Morning', 10_500], ['Evening', 21_000]])

    const length = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send(draft(s, addressId, { deliveries: 30 }))
    expect([length.status, length.body.error.code]).toEqual([409, 'LENGTH_NOT_OFFERED'])
    const early = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send(draft(s, addressId, { startDate: '2026-10-10' }))
    expect([early.status, early.body.error.code]).toEqual([409, 'START_TOO_EARLY'])
    const twice = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send(draft(s, addressId, { lines: [{ slotId: s.slot, quantity: 1 }, { slotId: s.slot, quantity: 1 }] }))
    expect(twice.status).toBe(400)
    const stale = await subscribe(api, token, { ...draft(s, addressId), expectedTotalPaise: 1 })
    expect([stale.status, stale.body.error.code]).toEqual([409, 'PRICE_CHANGED'])
  })

  it('starts a credit subscription at once and makes the coming days\' orders, which show in the customer orders list', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const body = { ...draft(s, addressId, { lines: [{ slotId: s.slot, quantity: 1 }, { slotId: s.evening, quantity: 2 }] }), idempotencyKey: 'key-sub-credit' }
    const started = await subscribe(api, token, body)
    expect(started.status).toBe(201)
    expect(started.body.payment).toBeNull()
    const subscription = started.body.subscription
    expect(subscription).toMatchObject({ status: 'active', endDate: '2026-10-13', nextDelivery: { date: '2026-10-11', slotName: 'Morning', quantity: 1 } })
    const made = api.orders.orders.filter(order => order.subscriptionId === subscription.id)
    expect(made).toHaveLength(6)
    expect(made.every(order => order.items[0]?.purchaseMethod === 'subscription' && order.paymentMethod === 'credit')).toBe(true)
    expect(api.orders.ledger.reduce((sum, row) => sum + row.amountPaise, 0)).toBe(31_500)

    const again = await subscribe(api, token, body)
    expect(again.body.subscription.id).toBe(subscription.id)
    expect(api.subscriptions.subscriptions).toHaveLength(1)
    const listed = (await request(api.app).get('/customer/orders').set(bearer(token))).body.orders as { deliveryDate: string }[]
    expect(listed).toHaveLength(made.length)
    // The nearest delivery comes first, then the next, then the next.
    expect(listed.map(order => order.deliveryDate)).toEqual([...listed.map(order => order.deliveryDate)].sort())
    const calendar = await request(api.app).get('/customer/deliveries?from=2026-10-10&to=2026-10-20').set(bearer(token))
    expect(calendar.body.deliveries.map((entry: { date: string; slotName: string; state: string }) => `${entry.date} ${entry.slotName} ${entry.state}`)).toEqual([
      '2026-10-11 Morning placed', '2026-10-11 Evening placed', '2026-10-12 Morning placed', '2026-10-12 Evening placed', '2026-10-13 Morning placed', '2026-10-13 Evening placed',
    ])
  })

  it('takes the whole amount upfront online, and starts the subscription only once PhonePe confirms', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const started = await subscribe(api, token, draft(s, addressId))
    expect(started.status).toBe(201)
    expect(started.body.subscription).toBeNull()
    expect(started.body.payment).toMatchObject({ purpose: 'subscription', amountPaise: 10_500 })
    expect(api.subscriptions.subscriptions).toHaveLength(0)
    const confirmed = await request(api.app).post(`/customer/payments/${started.body.payment.merchantOrderId}/confirm`).set(bearer(token))
    expect(confirmed.body.payment.subscription).toMatchObject({ number: 'SUB-1001' })
    const stored = api.subscriptions.subscriptions[0]
    expect(stored).toMatchObject({ paymentMethod: 'online', status: 'active', totalPaise: 10_500 })

    // The orders are made as soon as PhonePe confirms, not at the next run of the delivery job.
    expect(api.orders.orders.filter(order => order.subscriptionId === stored?.id)).toHaveLength(3)
    const run = await adminSend(api, s.cookie, 'post', '/admin/subscriptions/run', {})
    expect(run.body.result).toMatchObject({ created: 0, failures: 0 })
    expect(api.orders.orders.every(order => order.paymentStatus === 'paid' && order.paymentId === stored?.paymentId)).toBe(true)
  })

  it('allows one running trial of a product at a time, and a new one once it has ended', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const trial = { kind: 'trial', variantId: s.milkVariant, trialPlanId: s.trialId, startDate: '2026-10-11', addressId, lines: [{ slotId: s.slot, quantity: 1 }] }
    const first = await subscribe(api, token, trial)
    expect(first.body.subscription).toMatchObject({ kind: 'trial', scheduleType: 'daily', deliveriesPerLine: 2, endDate: '2026-10-12' })
    const second = await subscribe(api, token, trial)
    expect([second.status, second.body.error.code]).toEqual([409, 'TRIAL_ALREADY_USED'])
    await request(api.app).post(`/customer/subscriptions/${first.body.subscription.id}/cancel`).set(bearer(token)).send({ reason: 'Not needed' })
    const again = await subscribe(api, token, trial)
    expect([again.status, again.body]).toEqual([201, expect.anything()])
  })

  it('refunds a second trial paid online at the same time instead of starting it twice', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const trial = { kind: 'trial', variantId: s.milkVariant, trialPlanId: s.trialId, startDate: '2026-10-11', addressId, lines: [{ slotId: s.slot, quantity: 1 }] }
    const first = await subscribe(api, token, trial)
    const second = await subscribe(api, token, trial)
    await request(api.app).post(`/customer/payments/${first.body.payment.merchantOrderId}/confirm`).set(bearer(token))
    const late = await request(api.app).post(`/customer/payments/${second.body.payment.merchantOrderId}/confirm`).set(bearer(token))
    expect(late.body.payment).toMatchObject({ status: 'paid', fulfilment: 'refund_due' })
    expect(api.subscriptions.subscriptions).toHaveLength(1)
    expect(api.orders.adjustments).toEqual([expect.objectContaining({ type: 'refund_pending', amountPaise: 7000 })])
  })
})

describe('renaming a delivery slot', () => {
  it('shows the new name and times everywhere at once: orders, subscriptions, the calendar and the admin lists', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 1_000_000)
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    const oneTime = (await place(api, token, milkOrder(s, addressId, 'key-rename-1'))).body.orders[0]
    const slotName = async () => ({
      order: (await request(api.app).get(`/customer/orders/${oneTime.id}`).set(bearer(token))).body.order.slot.name,
      subscription: (await request(api.app).get(`/customer/subscriptions/${id}`).set(bearer(token))).body.subscription.lines[0].slotName,
      calendar: (await request(api.app).get('/customer/deliveries?from=2026-10-10&to=2026-10-20').set(bearer(token))).body.deliveries[0].slotName,
      admin: (await adminGet(api, s.cookie, `/admin/orders/${oneTime.id}`)).body.order.slot.name,
    })
    expect(await slotName()).toEqual({ order: 'Morning', subscription: 'Morning', calendar: 'Morning', admin: 'Morning' })
    const renamed = await adminSend(api, s.cookie, 'put', `/admin/delivery-slots/${s.slot}`, { name: 'Early morning', startTime: '04:30', endTime: '06:30' })
    expect(renamed.status).toBe(200)
    expect(await slotName()).toEqual({ order: 'Early morning', subscription: 'Early morning', calendar: 'Early morning', admin: 'Early morning' })
    const subscription = (await request(api.app).get(`/customer/subscriptions/${id}`).set(bearer(token))).body.subscription
    expect(subscription.lines[0]).toMatchObject({ startTime: '04:30', endTime: '06:30' })
  })
})

describe('the shortest and longest plan a rule allows', () => {
  it('seeds 5 and 180 days, saves staff changes, and refuses a longest shorter than the shortest', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const made = await adminSend(api, s.cookie, 'post', '/admin/subscription-rules', { name: 'Plain', systemType: 'daily' })
    expect(made.body.subscriptionRule).toMatchObject({ minDays: 5, maxDays: 180 })
    const id = made.body.subscriptionRule.id as string
    const changed = await adminSend(api, s.cookie, 'put', `/admin/subscription-rules/${id}`, { name: 'Plain', systemType: 'daily', minDays: 7, maxDays: 90 })
    expect(changed.body.subscriptionRule).toMatchObject({ minDays: 7, maxDays: 90 })
    const backwards = await adminSend(api, s.cookie, 'put', `/admin/subscription-rules/${id}`, { name: 'Plain', systemType: 'daily', minDays: 30, maxDays: 10 })
    expect([backwards.status, backwards.body.error.details[0].field]).toEqual([400, 'maxDays'])
    expect((await adminSend(api, s.cookie, 'put', `/admin/subscription-rules/${id}`, { name: 'Plain', systemType: 'daily', minDays: 0 })).status).toBe(400)
  })

  it('tells the phone the shortest and longest plan of each rule on the product page', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const product = await request(api.app).get(`/public/products/${s.milk.id}`)
    expect(product.body.product.subscriptionRules[0]).toMatchObject({ minDays: 3, maxDays: 20, lengthOptions: [3, 5] })
  })
})

describe('choosing the last day on a calendar', () => {
  it('counts the deliveries from the last day picked and prices them, for daily and every other day', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 1_000_000)
    const base = withoutLength(draft(s, addressId))
    const daily = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send({ ...base, endDate: '2026-10-17' })
    expect(daily.body.quote).toMatchObject({ deliveriesPerLine: 7, endDate: '2026-10-17', totalPaise: 3500 * 7 })
    const alternateRule = (await adminSend(api, s.cookie, 'post', '/admin/subscription-rules', { name: 'Every other day', systemType: 'alternate_days', minDays: 3, maxDays: 20 })).body.subscriptionRule.id as string
    Object.assign(api.products.rows.find(product => product.id === s.milk.id) ?? {}, { subscriptionRuleIds: [s.ruleId, alternateRule] })
    const alternate = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send({ ...base, ruleId: alternateRule, endDate: '2026-10-18' })
    // Starting 11 Oct, every other day: 11, 13, 15, 17. The 18th is not a delivery day, so the plan ends on the 17th.
    expect(alternate.body.quote).toMatchObject({ deliveriesPerLine: 4, endDate: '2026-10-17' })
    // The shortest plan is measured to the last delivery day: on this every-other-day plan the 12th still has only the 11th delivered.
    const tooShort = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send({ ...base, ruleId: alternateRule, endDate: '2026-10-12' })
    expect([tooShort.status, tooShort.body.error.code]).toEqual([409, 'LENGTH_TOO_SHORT'])
  })

  it('refuses a plan shorter or longer than the rule allows, and a last day before the first', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 10_000_000)
    const base = withoutLength(draft(s, addressId))
    const quote = (endDate: string) => request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send({ ...base, endDate })
    const short = await quote('2026-10-12')
    expect([short.status, short.body.error.code, short.body.error.details.minDays]).toEqual([409, 'LENGTH_TOO_SHORT', 3])
    expect((await quote('2026-10-13')).status).toBe(200)
    expect((await quote('2026-10-30')).status).toBe(200)
    const long = await quote('2026-10-31')
    expect([long.status, long.body.error.code, long.body.error.details.maxDays]).toEqual([409, 'LENGTH_TOO_LONG', 20])
    expect((await quote('2026-10-10')).body.error.code).toBe('LENGTH_TOO_SHORT')
    const both = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send({ ...base, deliveries: 3, endDate: '2026-10-13' })
    expect(both.status).toBe(400)
  })

  it('starts the subscription with the deliveries counted from the last day, still checking the credit', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const base = withoutLength(draft(s, addressId))
    const started = await subscribe(api, token, { ...base, endDate: '2026-10-14' })
    expect(started.status).toBe(201)
    expect(started.body.subscription).toMatchObject({ deliveriesPerLine: 4, endDate: '2026-10-14' })
  })
})

describe('changing a subscription', () => {
  it('skips a day (cancelling its order, without charging it) and moves the end date later; undoing it brings the day back', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    const skipped = await request(api.app).post(`/customer/subscriptions/${id}/skip`).set(bearer(token)).send({ date: '2026-10-12' })
    expect(skipped.status).toBe(200)
    expect(skipped.body.subscription.endDate).toBe('2026-10-14')
    expect(api.orders.orders.find(order => order.deliveryDate === '2026-10-12')?.status).toBe('cancelled')
    expect(api.orders.ledger.map(row => row.type)).toEqual(['order_charge', 'order_charge', 'order_charge', 'order_refund'])
    const notADay = await request(api.app).post(`/customer/subscriptions/${id}/skip`).set(bearer(token)).send({ date: '2026-10-25' })
    expect(notADay.body.error.code).toBe('NOT_A_DELIVERY_DAY')

    // A customer's skip is final: they cannot undo it. Staff can bring the day back.
    const refused = await request(api.app).post(`/customer/subscriptions/${id}/unskip`).set(bearer(token)).send({ date: '2026-10-12' })
    expect([refused.status, refused.body.error.code]).toEqual([409, 'SKIP_IS_FINAL'])
    const undone = await adminSend(api, s.cookie, 'post', `/admin/subscriptions/${id}/unskip`, { date: '2026-10-12' })
    expect(undone.body.subscription.endDate).toBe('2026-10-13')
    expect(api.orders.orders.filter(order => order.deliveryDate === '2026-10-12').map(order => order.status)).toEqual(['cancelled', 'placed'])
  })

  it('refuses a skip once the day is locked', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    api.clock.set('2026-10-10T16:00:00.000Z') // 21:30 in India: the 11th is locked
    const late = await request(api.app).post(`/customer/subscriptions/${id}/skip`).set(bearer(token)).send({ date: '2026-10-11' })
    expect([late.status, late.body.error.code]).toEqual([409, 'SKIP_TOO_LATE'])
  })

  it('closes skipping at the rule\'s cancel time when it is earlier than the order cut-off', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const answer = api.slotRuleAnswers.get(s.milk.id)
    if (answer?.served) for (const slot of answer.slots) slot.condition = { dayRelation: 'previous_day', cutoffTime: '21:00', cancelDayRelation: 'previous_day', cancelTime: '12:00' }
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    api.clock.set('2026-10-10T07:00:00.000Z') // 12:30 in India: ordering for the 11th is still open, cancelling is not
    const late = await request(api.app).post(`/customer/subscriptions/${id}/skip`).set(bearer(token)).send({ date: '2026-10-11' })
    expect([late.status, late.body.error.code]).toEqual([409, 'SKIP_TOO_LATE'])
    expect((await request(api.app).post(`/customer/subscriptions/${id}/skip`).set(bearer(token)).send({ date: '2026-10-12' })).status).toBe(200)
  })

  it('pauses for a vacation or until resumed, holding the remaining deliveries', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    const open = await request(api.app).post(`/customer/subscriptions/${id}/pause`).set(bearer(token)).send({ fromDate: '2026-10-12' })
    expect(open.status).toBe(200)
    expect(open.body.subscription).toMatchObject({ endDate: null, openPause: { fromDate: '2026-10-12', untilDate: null } })
    // The paused days are listed as paused, so the customer sees them (and does not pause them again).
    expect(open.body.subscription.days.find((entry: { date: string }) => entry.date === '2026-10-13')?.lines[0]).toMatchObject({ state: 'paused', canChange: false })
    expect(api.orders.orders.filter(order => order.status === 'placed').map(order => order.deliveryDate)).toEqual(['2026-10-11'])
    const overlap = await request(api.app).post(`/customer/subscriptions/${id}/pause`).set(bearer(token)).send({ fromDate: '2026-10-15', untilDate: '2026-10-16' })
    expect(overlap.body.error.code).toBe('PAUSE_OVERLAPS')
    const resumed = await request(api.app).post(`/customer/subscriptions/${id}/resume`).set(bearer(token)).send({ fromDate: '2026-10-14' })
    expect(resumed.body.subscription.openPause).toBeNull()
    expect(resumed.body.subscription.endDate).toBe('2026-10-15')
    // Days the pause cancelled are not left as skips: resuming early brings them back.
    expect(api.orders.skips).toHaveLength(0)
  })

  it('cancels: stops new deliveries, cancels the changeable ones, and turns unused paid deliveries into a refund to send', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await customerSignUp(api, '9824612345')
    const started = await subscribe(api, token, draft(s, addressId))
    await request(api.app).post(`/customer/payments/${started.body.payment.merchantOrderId}/confirm`).set(bearer(token))
    await adminSend(api, s.cookie, 'post', '/admin/subscriptions/run', {})
    const id = api.subscriptions.subscriptions[0]?.id as string
    const cancelled = await request(api.app).post(`/customer/subscriptions/${id}/cancel`).set(bearer(token)).send({ reason: 'Moving house' })
    expect(cancelled.body.subscription.status).toBe('cancelled')
    expect(api.orders.orders.map(order => order.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(api.orders.adjustments).toEqual([expect.objectContaining({ type: 'refund_pending', amountPaise: 10_500, dedupeKey: `subscription-cancel:${id}` })])
    expect((await request(api.app).post(`/customer/subscriptions/${id}/cancel`).set(bearer(token)).send({})).body.error.code).toBe('SUBSCRIPTION_NOT_ACTIVE')
  })

  it('never shows or changes another customer\'s subscription', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    const other = await customerSignUp(api, '9898989898')
    expect((await request(api.app).get(`/customer/subscriptions/${id}`).set(bearer(other.token))).status).toBe(404)
    expect((await request(api.app).post(`/customer/subscriptions/${id}/cancel`).set(bearer(other.token)).send({})).status).toBe(404)
  })
})

describe('the delivery job', () => {
  it('refuses to start a credit subscription whose total is above the credit left, and tells the phone the numbers', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId, customerId } = await creditCustomer(api, 10_000)
    const quoted = await request(api.app).post('/customer/subscriptions/quote').set(bearer(token)).send(draft(s, addressId))
    expect(quoted.body.quote).toMatchObject({ totalPaise: 10_500, paymentMethod: 'credit', credit: { limitPaise: 10_000, owedPaise: 0, remainingPaise: 10_000 } })
    const refused = await subscribe(api, token, draft(s, addressId))
    expect([refused.status, refused.body.error.code]).toEqual([409, 'SUBSCRIPTION_ABOVE_CREDIT'])
    expect(refused.body.error.details).toMatchObject({ remainingPaise: 10_000, neededPaise: 10_500 })
    expect(api.subscriptions.subscriptions).toHaveLength(0)
    expect(api.orders.orders).toHaveLength(0)
    // What a customer already owes counts: the same plan no longer fits in a bigger limit that is partly used.
    api.orders.creditLimits.set(customerId, 12_000)
    api.orders.ledger.push({ id: 'old', customerId, type: 'order_charge', direction: 'debit', amountPaise: 2_000, orderId: null, paymentId: null, description: 'earlier', createdAt: '2026-10-09T00:00:00.000Z' })
    expect((await subscribe(api, token, draft(s, addressId))).body.error.code).toBe('SUBSCRIPTION_ABOVE_CREDIT')
    api.orders.creditLimits.set(customerId, 12_500)
    expect((await subscribe(api, token, draft(s, addressId))).status).toBe(201)
  })

  it('skips a day when the credit limit is used up later (the subscription runs a day longer) and alerts staff', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId, customerId } = await creditCustomer(api, 17_500)
    const id = (await subscribe(api, token, draft(s, addressId, { deliveries: 5 }))).body.subscription.id as string
    expect(api.orders.orders.map(order => order.deliveryDate)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13'])
    // The limit is lowered afterwards, so the next day's order does not fit.
    api.orders.creditLimits.set(customerId, 12_000)
    api.clock.set('2026-10-11T06:00:00.000Z')
    await adminSend(api, s.cookie, 'post', '/admin/subscriptions/run', {})
    expect(api.orders.skips).toEqual([expect.objectContaining({ subscriptionId: id, date: '2026-10-14', reason: 'credit_limit' })])
    const list = await adminGet(api, s.cookie, '/admin/subscriptions')
    expect(list.body.alerts).toEqual([expect.objectContaining({ subscriptionId: id, date: '2026-10-14', reason: 'credit_limit', slotName: 'Morning' })])
    expect(list.body.rows[0]).toMatchObject({ id, alerts: 1 })
    // The list counts each status for its tabs, and shows the nearest delivery whose order is made.
    expect(list.body.counts).toEqual({ active: 1, paused: 0, completed: 0, cancelled: 0 })
    expect(list.body.rows[0].nextDelivery).toEqual({ date: '2026-10-11', slotName: 'Morning' })
    expect(list.body.rows[0]).toMatchObject({ usedDeliveries: 3, deliveredDeliveries: 0 })
    expect((await adminGet(api, s.cookie, '/admin/subscriptions?status=cancelled')).body).toMatchObject({ total: 0, counts: { active: 1 } })
    expect((await adminGet(api, s.cookie, `/admin/subscriptions/${id}`)).body.subscription.endDate).toBe('2026-10-16')
  })

  it('closes a subscription once every delivery is behind it', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 100_000)
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    api.clock.set('2026-10-14T06:00:00.000Z')
    await adminSend(api, s.cookie, 'post', '/admin/subscriptions/run', {})
    expect(api.subscriptions.subscriptions.find(item => item.id === id)?.status).toBe('completed')
  })

  it('is for staff only', async () => {
    const api = await createTestApi()
    expect((await request(api.app).post('/admin/subscriptions/run').send({})).status).toBe(403)
  })
})

describe('telling the customer about their plan', () => {
  it('tells the customer when staff skip a day, but not when the customer skips it themselves', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId, customerId } = await creditCustomer(api, 100_000)
    const id = (await subscribe(api, token, draft(s, addressId, { deliveries: 5 }))).body.subscription.id as string
    await request(api.app).post(`/customer/subscriptions/${id}/skip`).set(bearer(token)).send({ date: '2026-10-12' })
    await api.notificationService.flush()
    expect(api.notificationStore.notifications).toHaveLength(0)
    const staff = await adminSend(api, s.cookie, 'post', `/admin/subscriptions/${id}/skip`, { date: '2026-10-13' })
    expect(staff.status).toBe(200)
    await api.notificationService.flush()
    expect(api.notificationStore.notifications).toEqual([expect.objectContaining({ customerId, event: 'day_skipped', link: `/subscription-manage?id=${id}`, body: expect.stringContaining('Tue 13 Oct') })])
  })

  it('tells a credit customer when a day is skipped because the credit limit is used up, once', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId, customerId } = await creditCustomer(api, 17_500)
    const id = (await subscribe(api, token, draft(s, addressId, { deliveries: 5 }))).body.subscription.id as string
    api.orders.creditLimits.set(customerId, 12_000)
    api.clock.set('2026-10-11T06:00:00.000Z')
    await adminSend(api, s.cookie, 'post', '/admin/subscriptions/run', {})
    await adminSend(api, s.cookie, 'post', '/admin/subscriptions/run', {})
    await api.notificationService.flush()
    expect(api.notificationStore.notifications).toEqual([expect.objectContaining({ customerId, event: 'credit_limit_reached', link: `/subscription-manage?id=${id}` })])
  })
})

describe('switching off a product with running plans', () => {
  it('refuses while a subscription or trial of it is running, and allows it once none is', async () => {
    const api = await createTestApi()
    const s = await subscribableShop(api)
    const { token, addressId } = await creditCustomer(api, 1_000_000)
    const id = (await subscribe(api, token, draft(s, addressId))).body.subscription.id as string
    const refused = await adminSend(api, s.cookie, 'patch', `/admin/products/${s.milk.id}/status`, { status: 'inactive' })
    expect([refused.status, refused.body.error.code]).toEqual([409, 'PRODUCT_HAS_RUNNING_PLANS'])
    expect(refused.body.error.message).toContain('1 subscription or trial is still running')
    expect(api.products.rows.find(product => product.id === s.milk.id)?.status).toBe('active')
    // Switching it off through the product form is refused the same way.
    const stored = api.products.rows.find(product => product.id === s.milk.id)
    const viaForm = await adminSend(api, s.cookie, 'put', `/admin/products/${s.milk.id}`, { ...stored, status: 'inactive', variants: stored?.variants ?? [], galleryAssetIds: [], trialPlanIds: stored?.trialPlanIds ?? [], subscriptionRuleIds: stored?.subscriptionRuleIds ?? [] })
    expect(viaForm.body.error?.code).toBe('PRODUCT_HAS_RUNNING_PLANS')
    await request(api.app).post(`/customer/subscriptions/${id}/cancel`).set(bearer(token)).send({ reason: 'Not needed' })
    const allowed = await adminSend(api, s.cookie, 'patch', `/admin/products/${s.milk.id}/status`, { status: 'inactive' })
    expect(allowed.status).toBe(200)
  })
})
