import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { MAX_ADDRESSES_PER_CUSTOMER } from '../src/modules/customer-addresses/schema.js'
import { createTestApi, type TestApi } from './fakes.js'
import { signUpByEmail } from './checkout-helpers.js'

async function signUp(api: TestApi, phone: string): Promise<string> {
  return (await signUpByEmail(api, phone)).token
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const home = { label: 'home', recipientName: 'Asha Patel', recipientPhone: '98246 12345', line1: 'B-12, Sunrise Society', line2: 'Sector 7', landmark: 'Near the temple', city: 'Gandhinagar', pinCode: '382010' }
const work = { ...home, label: 'work', line1: 'Office 3', pinCode: '400001' }
const save = (api: TestApi, token: string, body: object) => request(api.app).post('/customer/addresses').set(bearer(token)).send(body)
const list = async (api: TestApi, token: string) => (await request(api.app).get('/customer/addresses').set(bearer(token))).body.addresses as Array<{ id: string; label: string; isDefault: boolean; serviceable: boolean; pinCode: string; recipientPhone: string }>

describe('customer addresses', () => {
  it('need a signed-in customer, and are never cached', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/customer/addresses')).status).toBe(401)
    expect((await request(api.app).post('/customer/addresses').send(home)).status).toBe(401)
    const token = await signUp(api, '9824612345')
    expect((await request(api.app).get('/customer/addresses').set(bearer(token))).headers['cache-control']).toBe('no-store')
  })

  it('saves an address, tidies the phone number, and makes the first one the default', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    const response = await save(api, token, home)
    expect(response.status).toBe(201)
    expect(response.body.address).toMatchObject({ label: 'home', recipientPhone: '+919824612345', pinCode: '382010', isDefault: true, serviceable: true })
  })

  it.each(['', '   ', undefined])('saves and returns an address without a contact number (%j)', async recipientPhone => {
    const api = await createTestApi()
    const { token, customerId } = await signUpByEmail(api, '9824612345')
    const customer = api.customerAuth.customers.get(customerId)
    if (customer) customer.phone = null
    const response = await save(api, token, { ...home, recipientPhone })
    expect(response.status).toBe(201)
    expect(response.body.address.recipientPhone).toBe('')
    expect(await list(api, token)).toMatchObject([{ id: response.body.address.id, recipientPhone: '' }])
  })

  it('allows a saved contact number to be cleared', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    const { id } = (await save(api, token, home)).body.address
    const response = await request(api.app).put(`/customer/addresses/${id}`).set(bearer(token)).send({ ...home, recipientPhone: '' })
    expect(response.status).toBe(200)
    expect(await list(api, token)).toMatchObject([{ id, recipientPhone: '' }])
    expect((await save(api, token, { ...home, recipientPhone: '+91' })).status).toBe(400)
  })

  it('says whether each address can be delivered to, from the delivery check and not from anything stored', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    await save(api, token, home)
    await save(api, token, work)
    expect((await list(api, token)).map(address => [address.pinCode, address.serviceable])).toEqual([['382010', true], ['400001', false]])
    api.servedPins.add('400001')
    expect((await list(api, token)).every(address => address.serviceable)).toBe(true)
  })

  it('keeps exactly one default: choosing another moves it, and editing never loses it', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    await save(api, token, home)
    const second = (await save(api, token, { ...work, isDefault: true })).body.address
    expect((await list(api, token)).filter(address => address.isDefault).map(address => address.id)).toEqual([second.id])
    await request(api.app).put(`/customer/addresses/${second.id}`).set(bearer(token)).send({ ...work, isDefault: false })
    expect((await list(api, token)).filter(address => address.isDefault)).toHaveLength(1)
  })

  it('edits an address', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    const { id } = (await save(api, token, home)).body.address
    const response = await request(api.app).put(`/customer/addresses/${id}`).set(bearer(token)).send({ ...home, line1: 'C-1', pinCode: '110001' })
    expect(response.body.address).toMatchObject({ id, line1: 'C-1', pinCode: '110001', serviceable: true })
  })

  it('removes an address, and the default passes to the one that is left', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    const first = (await save(api, token, home)).body.address
    const second = (await save(api, token, work)).body.address
    expect((await request(api.app).delete(`/customer/addresses/${first.id}`).set(bearer(token))).status).toBe(204)
    expect(await list(api, token)).toMatchObject([{ id: second.id, isDefault: true }])
    expect(api.addressStore.rows.find(row => row.id === first.id)?.removed).toBe(true)
    expect((await request(api.app).delete(`/customer/addresses/${first.id}`).set(bearer(token))).body.error.code).toBe('ADDRESS_NOT_FOUND')
  })

  it('never shows, changes or removes another customer\'s address', async () => {
    const api = await createTestApi()
    const asha = await signUp(api, '9824612345')
    const ravi = await signUp(api, '9876543210')
    const { id } = (await save(api, asha, home)).body.address
    expect(await list(api, ravi)).toEqual([])
    expect((await request(api.app).put(`/customer/addresses/${id}`).set(bearer(ravi)).send(home)).status).toBe(404)
    expect((await request(api.app).delete(`/customer/addresses/${id}`).set(bearer(ravi))).status).toBe(404)
    expect(await list(api, asha)).toHaveLength(1)
  })

  it('refuses a bad PIN, a missing house number, a bad phone, and an unknown id', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    expect((await save(api, token, { ...home, pinCode: '12345' })).body.error.details[0].field).toBe('pinCode')
    expect((await save(api, token, { ...home, line1: '  ' })).status).toBe(400)
    expect((await save(api, token, { ...home, recipientPhone: '123' })).status).toBe(400)
    expect((await request(api.app).put('/customer/addresses/nope').set(bearer(token)).send(home)).status).toBe(400)
  })

  it('ignores fields it does not know, so nobody can write to another customer or force a status', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    await save(api, token, { ...home, customerId: 'someone-else', removed: true, serviceable: false })
    expect(api.addressStore.rows).toHaveLength(1)
    expect(api.addressStore.rows[0]?.customerId).not.toBe('someone-else')
    expect(api.addressStore.rows[0]?.removed).toBe(false)
  })

  it('caps the number of saved addresses', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    for (let count = 0; count < MAX_ADDRESSES_PER_CUSTOMER; count += 1) expect((await save(api, token, home)).status).toBe(201)
    expect((await save(api, token, home)).body.error.code).toBe('TOO_MANY_ADDRESSES')
  })
})

describe('doorstep instructions', () => {
  const instructions = { dropLocation: 'milk-box', handoff: 'leave-at-door', noDoorbell: true, noCall: false, notifyAfterDelivery: true, additionalInstructions: '  Dog in the garden  ' }

  it('start with sensible defaults, then save and come back', async () => {
    const api = await createTestApi()
    const token = await signUp(api, '9824612345')
    expect((await request(api.app).get('/customer/doorstep-instructions').set(bearer(token))).body.instructions).toMatchObject({ dropLocation: 'front-door', noDoorbell: true, notifyAfterDelivery: true })
    const saved = await request(api.app).put('/customer/doorstep-instructions').set(bearer(token)).send(instructions)
    expect(saved.body.instructions).toMatchObject({ dropLocation: 'milk-box', noDoorbell: true, additionalInstructions: 'Dog in the garden' })
    expect((await request(api.app).get('/customer/doorstep-instructions').set(bearer(token))).body.instructions.dropLocation).toBe('milk-box')
  })

  it('belong to the customer who saved them, and refuse unknown choices', async () => {
    const api = await createTestApi()
    const asha = await signUp(api, '9824612345')
    const ravi = await signUp(api, '9876543210')
    await request(api.app).put('/customer/doorstep-instructions').set(bearer(asha)).send(instructions)
    expect((await request(api.app).get('/customer/doorstep-instructions').set(bearer(ravi))).body.instructions.dropLocation).toBe('front-door')
    expect((await request(api.app).put('/customer/doorstep-instructions').set(bearer(asha)).send({ ...instructions, dropLocation: 'roof' })).status).toBe(400)
    expect((await request(api.app).get('/customer/doorstep-instructions')).status).toBe(401)
  })
})
