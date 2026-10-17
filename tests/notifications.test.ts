import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { audienceClause } from '../src/modules/notifications/repository.js'
import { formatDay, formatDayGujarati, formatRupees, pickLanguage, renderTemplate, safeLink } from '../src/modules/notifications/rules.js'
import { adminGet, adminSend, bearer, customerSignUp, milkOrder, place, shop } from './checkout-helpers.js'
import { ADMIN_ORIGIN, createTestApi, type TestApi } from './fakes.js'

const TOKEN = 'fcm-token-for-the-first-phone-0000000000'
const SECOND_TOKEN = 'fcm-token-for-the-second-phone-111111111'

/** A signed-in customer whose phone is registered for notifications. */
async function customerWithPhone(api: TestApi, phone: string, token = TOKEN) {
  const customer = await customerSignUp(api, phone)
  const registered = await request(api.app).post('/customer/push-tokens').set(bearer(customer.token)).send({ token, platform: 'android' })
  expect(registered.status).toBe(204)
  return customer
}
const inbox = async (api: TestApi, token: string) => (await request(api.app).get('/customer/notifications').set(bearer(token))).body as { notifications: Array<{ id: string; event: string; title: string; titleGujarati: string; body: string; link: string | null; readAt: string | null }>; unread: number; total: number }

describe('automatic messages', () => {
  it('tells the customer when an order is out for delivery and when it is delivered, and only once each', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const customer = await customerWithPhone(api, '9824612345')
    const order = (await place(api, customer.token, milkOrder(s, customer.addressId, 'key-notify-1'))).body.orders[0]
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'out_for_delivery' })
    await api.notificationService.flush()
    expect(api.notificationStore.pushes).toEqual([expect.objectContaining({ tokens: [TOKEN], title: 'On its way', body: `Your order ${order.orderNumber} is out for delivery.`, link: `/order-tracking?orderId=${order.id}` })])
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'delivered' })
    await api.notificationService.flush()
    const list = await inbox(api, customer.token)
    expect(list.notifications.map(item => item.event).sort()).toEqual(['delivered', 'out_for_delivery'])
    expect(list.unread).toBe(2)
    // The same occurrence announced again (a repeated press, a retried job) is stored and pushed once.
    const before = api.notificationStore.pushes.length
    await api.notificationService.notifier.notify({ event: 'delivered', customerId: customer.customerId, vars: { order: order.orderNumber }, dedupeKey: `order:${order.id}:delivered` })
    await api.notificationService.flush()
    expect(api.notificationStore.pushes).toHaveLength(before)
    expect((await inbox(api, customer.token)).total).toBe(2)
  })

  it('writes the push in the language the customer reads, and falls back to English for a missing Gujarati wording', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const customer = await customerWithPhone(api, '9824612345')
    // The phone reports the language the customer chose when it registers, and that is what messages are written in.
    await request(api.app).post('/customer/push-tokens').set(bearer(customer.token)).send({ token: TOKEN, platform: 'android', language: 'gu' })
    expect(api.customerAuth.customers.get(customer.customerId)?.language).toBe('gu')
    const order = (await place(api, customer.token, milkOrder(s, customer.addressId, 'key-notify-gu'))).body.orders[0]
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'out_for_delivery' })
    await api.notificationService.flush()
    expect(api.notificationStore.pushes[0]?.title).toBe('ડિલિવરી માટે નીકળી')
    expect(pickLanguage({ title: 'Hello', titleGujarati: '', body: 'Body', bodyGujarati: '' }, 'gu')).toEqual({ title: 'Hello', body: 'Body' })
  })

  it('uses the Gujarati product name and date in a Gujarati message, and sends it as delivery news', async () => {
    const api = await createTestApi()
    const customer = await customerWithPhone(api, '9824612345')
    await request(api.app).post('/customer/push-tokens').set(bearer(customer.token)).send({ token: TOKEN, platform: 'android', language: 'gu' })
    await api.notificationService.notifier.notify({
      event: 'day_skipped', customerId: customer.customerId,
      vars: { product: 'Buffalo Milk', date: formatDay('2026-10-17'), window: 'Morning' },
      varsGujarati: { product: 'ભેંસનું દૂધ', date: formatDayGujarati('2026-10-17') },
      dedupeKey: 'skip:test-gujarati',
    })
    await api.notificationService.flush()
    const push = api.notificationStore.pushes[0]
    expect(push?.channel).toBe('deliveries')
    expect(push?.body).toContain('ભેંસનું દૂધ')
    expect(push?.body).toContain(formatDayGujarati('2026-10-17'))
    expect(push?.body).not.toContain('Buffalo Milk')
  })

  it('sends nothing for a message staff switched off, to a blocked customer, or without a registered phone (the bell still has it)', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const customer = await customerSignUp(api, '9824612345')
    const order = (await place(api, customer.token, milkOrder(s, customer.addressId, 'key-notify-off'))).body.orders[0]
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'out_for_delivery' })
    await api.notificationService.flush()
    expect(api.notificationStore.pushes).toHaveLength(0)
    expect((await inbox(api, customer.token)).total).toBe(1)

    const delivered = (await adminGet(api, s.cookie, '/admin/notifications/templates')).body.templates.find((item: { key: string }) => item.key === 'delivered')
    const switchedOff = await adminSend(api, s.cookie, 'put', '/admin/notifications/templates/delivered', { title: delivered.title, titleGujarati: delivered.titleGujarati, body: delivered.body, bodyGujarati: delivered.bodyGujarati, enabled: false })
    expect(switchedOff.status).toBe(200)
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'delivered' })
    expect((await inbox(api, customer.token)).total).toBe(1)

    const stored = api.customerAuth.customers.get(customer.customerId)
    if (stored) stored.status = 'blocked'
    await api.notificationService.notifier.notify({ event: 'out_for_delivery', customerId: customer.customerId, vars: { order: 'X' }, dedupeKey: 'blocked-test' })
    expect(api.notificationStore.notifications).toHaveLength(1)
  })

  it('switches off a notification address the provider says is gone', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const customer = await customerWithPhone(api, '9824612345')
    await request(api.app).post('/customer/push-tokens').set(bearer(customer.token)).send({ token: SECOND_TOKEN, platform: 'android' })
    api.notificationStore.deadTokens.add(SECOND_TOKEN)
    const order = (await place(api, customer.token, milkOrder(s, customer.addressId, 'key-notify-dead'))).body.orders[0]
    await adminSend(api, s.cookie, 'post', `/admin/orders/${order.id}/status`, { status: 'out_for_delivery' })
    await api.notificationService.flush()
    expect(api.notificationStore.tokens.map(item => [item.token, item.active])).toEqual([[TOKEN, true], [SECOND_TOKEN, false]])
  })

  it('tells a credit customer when staff ask them to pay, and a prepaid customer when a refund is sent', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const credit = await customerWithPhone(api, '9824612345')
    const stored = api.customerAuth.customers.get(credit.customerId)
    if (stored) stored.customerType = 'credit'
    api.orders.creditLimits.set(credit.customerId, 50_000)
    api.orders.ledger.push({ id: 'old', customerId: credit.customerId, type: 'order_charge', direction: 'debit', amountPaise: 20_000, orderId: null, paymentId: null, description: 'earlier', createdAt: '2026-10-09T00:00:00.000Z' })
    const asked = await adminSend(api, s.cookie, 'post', `/admin/credit-accounts/${credit.customerId}/payment-requests`, { amountPaise: 12_550 })
    expect(asked.status).toBe(201)
    await api.notificationService.flush()
    expect((await inbox(api, credit.token)).notifications[0]).toMatchObject({ event: 'payment_requested', body: 'Please pay ₹125.50 to clear your balance.' })

    const prepaid = await customerWithPhone(api, '9824698765', SECOND_TOKEN)
    const order = (await place(api, prepaid.token, milkOrder(s, prepaid.addressId, 'key-refund-notify'))).body.orders[0]
    await request(api.app).post(`/customer/orders/${order.id}/cancel`).set(bearer(prepaid.token)).send({})
    const pending = (await adminGet(api, s.cookie, '/admin/prepaid-adjustments?status=pending')).body.rows[0]
    expect((await inbox(api, prepaid.token)).notifications.map(item => item.event)).not.toContain('refund_sent')
    await adminSend(api, s.cookie, 'post', `/admin/prepaid-adjustments/${pending.id}/apply`, { providerReference: 'PP-1' })
    await api.notificationService.flush()
    expect((await inbox(api, prepaid.token)).notifications[0]).toMatchObject({ event: 'refund_sent', body: 'Your refund of ₹70 has been sent.' })
  })
})

describe('the wording of the messages', () => {
  it('lists the six messages for staff and refuses wording that uses something the message does not know', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const listed = await adminGet(api, s.cookie, '/admin/notifications/templates')
    expect(listed.body.templates.map((item: { key: string }) => item.key)).toEqual(['out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent'])
    expect(listed.body.templates[0]).toMatchObject({ label: 'Out for delivery', placeholders: ['order', 'product'], enabled: true })
    const wording = { titleGujarati: '', bodyGujarati: '', enabled: true }
    const refused = await adminSend(api, s.cookie, 'put', '/admin/notifications/templates/delivered', { ...wording, title: 'Delivered', body: 'Hello {{secret}}' })
    expect([refused.status, refused.body.error.code]).toEqual([400, 'UNKNOWN_PLACEHOLDER'])
    const saved = await adminSend(api, s.cookie, 'put', '/admin/notifications/templates/delivered', { ...wording, title: 'At your door', body: 'Order {{order}} is here.' })
    expect(saved.body.template).toMatchObject({ key: 'delivered', title: 'At your door', body: 'Order {{order}} is here.' })
    expect((await request(api.app).get('/admin/notifications/templates').set('Origin', ADMIN_ORIGIN)).status).toBe(401)
  })
})

describe('the bell on the phone', () => {
  it('shows only the customer\'s own messages and lets them mark one or all as read', async () => {
    const api = await createTestApi()
    const first = await customerWithPhone(api, '9824612345')
    const second = await customerWithPhone(api, '9824698765', SECOND_TOKEN)
    for (const [index, customer] of [first, first, second].entries()) await api.notificationService.notifier.notify({ event: 'payment_requested', customerId: customer.customerId, vars: { amount: '₹10' }, dedupeKey: `bell-${index}` })
    expect((await request(api.app).get('/customer/notifications/unread-count').set(bearer(first.token))).body).toEqual({ unread: 2 })
    const mine = await inbox(api, first.token)
    expect(mine.total).toBe(2)
    const other = (await inbox(api, second.token)).notifications[0]?.id as string
    expect((await request(api.app).post(`/customer/notifications/${other}/read`).set(bearer(first.token))).status).toBe(404)
    expect((await request(api.app).post(`/customer/notifications/${mine.notifications[0]?.id}/read`).set(bearer(first.token))).status).toBe(204)
    expect((await inbox(api, first.token)).unread).toBe(1)
    expect((await request(api.app).post('/customer/notifications/read-all').set(bearer(first.token))).body).toEqual({ updated: 1 })
    expect((await inbox(api, first.token)).unread).toBe(0)
    expect((await inbox(api, second.token)).unread).toBe(1)
    expect((await request(api.app).get('/customer/notifications')).status).toBe(401)
  })

  it('ties a phone to whoever signed in last and stops pushing after they sign out', async () => {
    const api = await createTestApi()
    const first = await customerWithPhone(api, '9824612345')
    const second = await customerWithPhone(api, '9824698765')
    expect(api.notificationStore.tokens).toEqual([expect.objectContaining({ token: TOKEN, customerId: second.customerId, active: true })])
    await request(api.app).post('/customer/push-tokens/remove').set(bearer(second.token)).send({ token: TOKEN })
    expect(api.notificationStore.tokens[0]?.active).toBe(false)
    expect((await request(api.app).post('/customer/push-tokens').set(bearer(first.token)).send({ token: 'short', platform: 'android' })).status).toBe(400)
  })
})

describe('broadcasts', () => {
  it('sends to the chosen group only, in each customer\'s language, and keeps a record', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const prepaid = await customerWithPhone(api, '9824612345')
    const credit = await customerWithPhone(api, '9824698765', SECOND_TOKEN)
    const stored = api.customerAuth.customers.get(credit.customerId)
    if (stored) Object.assign(stored, { customerType: 'credit', language: 'gu' })
    const blocked = await customerSignUp(api, '9824611111')
    const blockedCustomer = api.customerAuth.customers.get(blocked.customerId)
    if (blockedCustomer) blockedCustomer.status = 'blocked'

    const everyone = await adminSend(api, s.cookie, 'post', '/admin/notifications/audience', { audience: { type: 'all' } })
    expect(everyone.body).toEqual({ customers: 2, withDevices: 2 })
    const group = await adminSend(api, s.cookie, 'post', '/admin/notifications/audience', { audience: { type: 'filter', customerType: 'credit' } })
    expect(group.body).toEqual({ customers: 1, withDevices: 1 })

    const sent = await adminSend(api, s.cookie, 'post', '/admin/notifications/broadcasts', { title: 'Diwali', titleGujarati: 'દિવાળી', body: 'Happy Diwali!', bodyGujarati: 'દિવાળી મુબારક!', audience: { type: 'filter', customerType: 'credit' } })
    expect(sent.status).toBe(201)
    expect(sent.body.broadcast).toMatchObject({ recipients: 1, status: 'sending' })
    await api.notificationService.flush()
    // A message to a group is an offer or news, which the customer can mute separately from delivery news.
    expect(api.notificationStore.pushes).toEqual([expect.objectContaining({ tokens: [SECOND_TOKEN], title: 'દિવાળી', body: 'દિવાળી મુબારક!', link: '/notifications', channel: 'offers' })])
    expect((await inbox(api, credit.token)).notifications[0]).toMatchObject({ event: 'broadcast', title: 'Diwali' })
    expect((await inbox(api, prepaid.token)).total).toBe(0)
    const history = await adminGet(api, s.cookie, '/admin/notifications/broadcasts')
    expect(history.body.rows).toEqual([expect.objectContaining({ title: 'Diwali', recipients: 1, pushed: 1, status: 'sent' })])
  })

  it('reaches customers picked one by one, and refuses a group with nobody in it', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const chosen = await customerWithPhone(api, '9824612345')
    await customerWithPhone(api, '9824698765', SECOND_TOKEN)
    const sent = await adminSend(api, s.cookie, 'post', '/admin/notifications/broadcasts', { title: 'Just you', body: 'Hello', audience: { type: 'customers', customerIds: [chosen.customerId] } })
    expect(sent.body.broadcast.recipients).toBe(1)
    await api.notificationService.flush()
    expect(api.notificationStore.pushes).toEqual([expect.objectContaining({ tokens: [TOKEN], title: 'Just you' })])
    const nobody = await adminSend(api, s.cookie, 'post', '/admin/notifications/broadcasts', { title: 'Nobody', body: 'Hello', audience: { type: 'filter', customerType: 'credit' } })
    expect([nobody.status, nobody.body.error.code]).toEqual([409, 'NO_RECIPIENTS'])
    const tooMany = await adminSend(api, s.cookie, 'post', '/admin/notifications/broadcasts', { title: 'x'.repeat(61), body: 'Hello', audience: { type: 'all' } })
    expect(tooMany.status).toBe(400)
    expect((await request(api.app).post('/admin/notifications/broadcasts').set('Origin', ADMIN_ORIGIN).send({})).status).toBe(401)
  })
})

describe('message rules', () => {
  it('fills in placeholders, formats money and days, and only allows known app screens as links', () => {
    expect(renderTemplate('Order {{order}} for {{date}}{{missing}}', { order: 'SRM-1', date: 'Sat 17 Oct' })).toBe('Order SRM-1 for Sat 17 Oct')
    expect([formatRupees(125_000), formatRupees(12_550), formatRupees(7000)]).toEqual(['₹1,250', '₹125.50', '₹70'])
    expect(formatDay('2026-10-17')).toBe('Sat 17 Oct')
    expect(safeLink('/order-tracking?orderId=abc')).toBe('/order-tracking?orderId=abc')
    expect([safeLink('https://evil.example'), safeLink('/admin'), safeLink('/orders bad'), safeLink(null)]).toEqual([null, null, null, null])
  })

  it('builds the audience filter from bound values only', () => {
    expect(audienceClause({ type: 'all' })).toEqual({ where: "c.status = 'active'", params: [] })
    const group = audienceClause({ type: 'filter', customerType: 'credit', pinCodes: ['382010'], hasActiveSubscription: true })
    expect(group.params).toEqual(['credit', ['382010']])
    expect(group.where).toContain('c.customer_type = $1')
    expect(group.where).toContain('a.pin_code = any($2::text[])')
    expect(group.where).toContain("s.status = 'active'")
    expect(group.where).not.toContain('382010')
    expect(audienceClause({ type: 'customers', customerIds: ['1b4e28ba-2fa1-11d2-883f-0016d3cca427'] }).where).toContain('c.id = any($1::uuid[])')
  })
})
