import { describe, expect, it } from 'vitest'
import { createTestApi } from './fakes.js'
import { customerSignUp, quote, shop } from './checkout-helpers.js'

describe('adversarial cart request boundaries', () => {
  it('does not combine the same variant selected for different delivery windows', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612391')
    const answer = api.deliveryAnswers.get(s.milk.id)
    if (!answer?.served) throw new Error('fixture must serve milk')
    const eveningId = '22222222-2222-4222-8222-222222222222'
    api.deliveryAnswers.set(s.milk.id, { ...answer, slots: [...answer.slots, { ...answer.slots[0]!, slotId: eveningId, name: 'Evening', startTime: '17:00', endTime: '19:00' }] })
    const result = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 2, slotId: s.slot }, { variantId: s.milkVariant, quantity: 3, slotId: eveningId }] })
    expect(result.status).toBe(200)
    expect(result.body.quote.orders).toHaveLength(2)
    expect(result.body.quote.orders.map((order: { selectedSlotId: string }) => order.selectedSlotId).sort()).toEqual([s.slot, eveningId].sort())
    expect(result.body.quote.orders.map((order: { items: {quantity: number}[] }) => order.items[0]!.quantity).sort()).toEqual([2, 3])
  })

  it('does not bypass the per-line maximum by repeating the same variant and slot', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612392')
    const result = await quote(api, token, { addressId, lines: Array.from({length: 40}, () => ({ variantId: s.milkVariant, quantity: 100, slotId: s.slot })) })
    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('refuses one-time checkout of a trial-only product even with a valid variant id', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const product = api.products.rows.find(item => item.id === s.milk.id)
    if (!product) throw new Error('fixture product missing')
    product.purchaseMethods = ['trial']
    const { token, addressId } = await customerSignUp(api, '9824612393')
    const result = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 1, slotId: s.slot }] })
    expect(result.status).toBe(409)
  })

  it('does not silently replace an explicit unavailable delivery window with another window', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const { token, addressId } = await customerSignUp(api, '9824612394')
    const result = await quote(api, token, { addressId, lines: [{ variantId: s.milkVariant, quantity: 1, slotId: '33333333-3333-4333-8333-333333333333' }] })
    expect(result.status).toBe(200)
    expect(result.body.quote.problems.map((problem: {code: string}) => problem.code)).toContain('SLOT_NOT_AVAILABLE')
    expect(result.body.quote.orders[0].selectedSlotId).toBeNull()
  })
})

describe('existing checkout security controls', () => {
  it('rejects another customer address and malformed quantities', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const mine = await customerSignUp(api, '9824612395')
    const other = await customerSignUp(api, '9824612396')
    const stolen = await quote(api, mine.token, { addressId: other.addressId, lines: [{variantId:s.milkVariant,quantity:1}] })
    expect(stolen.status).toBe(404)
    for (const quantity of [0, -1, 1.5, 101, '1']) {
      const result = await quote(api, mine.token, { addressId: mine.addressId, lines: [{variantId:s.milkVariant,quantity}] })
      expect(result.status).toBe(400)
    }
  })

  it('prices mixed courier and local items from the server and never assigns courier a delivery window', async () => {
    const api = await createTestApi()
    const s = await shop(api)
    const {token,addressId} = await customerSignUp(api, '9824612397')
    const result = await quote(api, token, { addressId, lines: [{variantId:s.milkVariant,quantity:1,slotId:s.slot,pricePaise:1},{variantId:s.gheeVariant,quantity:1,pricePaise:1}],totalPaise:2 })
    expect(result.status).toBe(200)
    expect(result.body.quote.totalPaise).toBe(25500)
    expect(result.body.quote.orders).toHaveLength(2)
    expect(result.body.quote.orders.find((order:{deliveryMethod:string}) => order.deliveryMethod === 'shipping').selectedSlotId).toBeNull()
    // Naming a delivery window for a courier product is refused instead of being quietly ignored.
    const withWindow = await quote(api, token, { addressId, lines: [{variantId:s.gheeVariant,quantity:1,slotId:s.slot}] })
    expect(withWindow.body.error.code).toBe('SLOT_NOT_AVAILABLE')
  })
})
