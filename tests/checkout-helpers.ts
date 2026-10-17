import request from 'supertest'
import { ADMIN_ORIGIN, PASSWORD, type TestApi } from './fakes.js'

/* Shared by the order and payment tests: a signed-in admin, a signed-up customer with an address, and a live shop. */

export async function adminSignedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
export const adminSend = (api: TestApi, cookie: string, method: 'post' | 'put' | 'patch', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
export const adminGet = (api: TestApi, cookie: string, path: string) => request(api.app).get(path).set('Cookie', cookie)

/** The email a test customer signs in with, made from the phone number the test uses to tell customers apart. */
export const testEmail = (phone: string) => `c${phone.replace(/\D/g, '')}@example.com`

/** Signs a customer up the way the phone app does (a code sent to their email), and gives them the contact phone older tests expect. */
export async function signUpByEmail(api: TestApi, phone: string) {
  const email = testEmail(phone)
  await request(api.app).post('/customer/auth/request-code').send({ email })
  const response = await request(api.app).post('/customer/auth/verify').send({ email, code: api.sentCustomerCodes.at(-1)?.code })
  api.clock.advanceMinutes(2)
  const customerId = response.body.customer?.id as string
  const stored = api.customerAuth.customers.get(customerId)
  if (stored) stored.phone = `+91${phone}`
  return { token: response.body.token as string, customerId, response }
}

export async function customerSignUp(api: TestApi, phone: string) {
  const { token, customerId } = await signUpByEmail(api, phone)
  const address = await request(api.app).post('/customer/addresses').set(bearer(token)).send({ label: 'home', recipientName: 'Asha Patel', recipientPhone: '98246 12345', line1: 'B-12, Sunrise Society', city: 'Gandhinagar', pinCode: '382010' })
  return { token, customerId, addressId: address.body.address.id as string }
}
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

export const variant = (name: string, pricePaise: number) => ({ name, pricePaise, displayUnit: 'ml', displayQuantity: 500, productionUnit: 'Litre', productionQuantity: 0.5 })

/** A live shop: a Morning slot, a PIN-code area, milk (own delivery, with a cut-off) and ghee (courier shipping across India). */
export async function shop(api: TestApi) {
  const cookie = await adminSignedIn(api)
  const category = (await adminSend(api, cookie, 'post', '/admin/categories', { name: 'Dairy' })).body.category.id as string
  const slot = (await adminSend(api, cookie, 'post', '/admin/delivery-slots', { name: 'Morning', startTime: '05:00', endTime: '07:00' })).body.slot.id as string
  const area = (await adminSend(api, cookie, 'post', '/admin/service-areas', { name: 'Gandhinagar', coverageType: 'pin_code', state: 'Gujarat', city: 'Gandhinagar' })).body.area.id as string
  const india = (await adminSend(api, cookie, 'post', '/admin/service-areas', { name: 'All India', coverageType: 'pan_india', state: '', city: '' })).body.area.id as string
  const rule = (await adminSend(api, cookie, 'post', '/admin/cutoff-rules', { name: 'By 9 PM', conditions: [{ deliverySlotId: slot, dayRelation: 'previous_day', cutoffTime: '21:00' }] })).body.rule.id as string
  const live = { categoryId: category, status: 'active', purchaseMethods: ['buy_once'] }
  const milk = (await adminSend(api, cookie, 'post', '/admin/products', { ...live, name: 'Cow Milk', deliveryMethod: 'local_delivery', serviceAreaId: area, cutoffRuleId: rule, includeInProductionPlanning: true, variants: [variant('500 ml', 3500), variant('1 L', 6500)] })).body.product
  const ghee = (await adminSend(api, cookie, 'post', '/admin/products', { ...live, name: 'Cow Ghee', deliveryMethod: 'shipping', serviceAreaId: india, variants: [variant('250 g', 22000)] })).body.product
  const served = { served: true as const, deliveryMethod: 'local_delivery' as const, locality: 'Sector 10', slots: [{ slotId: slot, name: 'Morning', startTime: '05:00', endTime: '07:00', earliestDate: '2026-10-11', orderBy: '2026-10-10T15:30:00.000Z', cancelBy: '2026-10-10T15:30:00.000Z' }] }
  api.deliveryAnswers.set(milk.id, served)
  api.deliveryAnswers.set(ghee.id, { served: true, deliveryMethod: 'shipping', locality: '', slots: [] })
  const setupKey = `local_delivery:${area}:${rule}`
  return { cookie, slot, milk, ghee, milkVariant: milk.variants[0].id as string, milkLiter: milk.variants[1].id as string, gheeVariant: ghee.variants[0].id as string, setupKey, area }
}
export type Shop = Awaited<ReturnType<typeof shop>>

/**
 * Checks out the way the phone does: a credit-only cart is placed at once; anything paid online first starts a payment, PhonePe
 * (the fake, completing at once by default) takes it, and the phone asks the server to confirm. Answers like the old single call.
 */
export async function place(api: TestApi, token: string, body: object): Promise<Pick<request.Response, 'status' | 'body'>> {
  const direct = await request(api.app).post('/customer/orders').set(bearer(token)).send(body)
  if (direct.status !== 409 || direct.body.error?.code !== 'PAYMENT_REQUIRED') return direct
  const started = await request(api.app).post('/customer/orders/payments').set(bearer(token)).send(body)
  if (started.status !== 201) return started
  const confirmed = await request(api.app).post(`/customer/payments/${started.body.payment.merchantOrderId}/confirm`).set(bearer(token))
  return confirmed.status === 200 ? { status: 201, body: { orders: confirmed.body.payment.orders } } : confirmed
}
export const quote = (api: TestApi, token: string, body: object) => request(api.app).post('/customer/orders/quote').set(bearer(token)).send(body)
export const milkOrder = (s: Shop, addressId: string, key: string, quantity = 2) => ({ addressId, lines: [{ variantId: s.milkVariant, quantity }], slots: { [s.setupKey]: s.slot }, idempotencyKey: key })
