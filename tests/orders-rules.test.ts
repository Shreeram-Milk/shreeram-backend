import { describe, expect, it } from 'vitest'
import { canReturnMoney, canTransition, creditEligible, customerCanCancel, doorstepNoteOf, groupBySetup, mergeLines, releasesMoney, subtotalPaise, withinCreditLimit, type CartLine, type CheckoutVariant } from '../src/modules/orders/rules.js'

const variant = (extra: Partial<CheckoutVariant> = {}): CheckoutVariant => ({
  variantId: 'v1', variantName: '500 ml', pricePaise: 3500, variantActive: true, productId: 'p1', productName: 'Milk', productNameGu: '', productActive: true, categoryActive: true, purchaseMethods: ['buy_once'],
  deliveryMethod: 'local_delivery', serviceAreaId: 'area-1', cutoffRuleId: 'rule-1', includeInProductionPlanning: true, excludedFromCredit: false, productionUnit: 'Litre', productionQuantity: 0.5, ...extra,
})
const line = (extra: Partial<CheckoutVariant>, quantity = 1): CartLine => ({ variant: variant(extra), quantity })
const ids = (lines: CartLine[]) => lines.map(item => item.variant.variantId)

describe('order status steps', () => {
  it('allows only the legal moves and treats delivered, missed and cancelled as final', () => {
    expect(canTransition('placed', 'out_for_delivery')).toBe(true)
    expect(canTransition('out_for_delivery', 'delivered')).toBe(true)
    expect(canTransition('placed', 'delivered')).toBe(false)
    for (const final of ['delivered', 'missed', 'cancelled'] as const) {
      for (const next of ['placed', 'out_for_delivery', 'delivered', 'missed', 'cancelled'] as const) expect(canTransition(final, next)).toBe(false)
    }
  })
  it('gives the money back by itself only for a cancelled order; staff may return it for a missed or delivered one', () => {
    expect([releasesMoney('cancelled'), releasesMoney('missed'), releasesMoney('delivered'), releasesMoney('out_for_delivery')]).toEqual([true, false, false, false])
    expect([canReturnMoney('missed'), canReturnMoney('delivered'), canReturnMoney('placed'), canReturnMoney('cancelled')]).toEqual([true, true, false, false])
  })
})

describe('when a customer may cancel', () => {
  const now = new Date('2026-10-14T12:00:00.000Z')
  it('uses the cancel deadline saved with the order before its order-by time', () => {
    const order = { status: 'placed' as const, deliveryMethod: 'local_delivery' as const, orderBy: '2026-10-14T15:30:00.000Z', deliveryDate: '2026-10-15' }
    expect(customerCanCancel({ ...order, cancelBy: '2026-10-14T11:00:00.000Z' }, now)).toBe(false)
    expect(customerCanCancel({ ...order, cancelBy: '2026-10-14T13:00:00.000Z' }, now)).toBe(true)
    expect(customerCanCancel({ ...order, cancelBy: null }, now)).toBe(true)
  })
  it('allows it before the order-by time and not after, and never once it is on its way', () => {
    expect(customerCanCancel({ status: 'placed', deliveryMethod: 'local_delivery', orderBy: '2026-10-14T15:30:00.000Z', deliveryDate: '2026-10-15' }, now)).toBe(true)
    expect(customerCanCancel({ status: 'placed', deliveryMethod: 'local_delivery', orderBy: '2026-10-14T11:59:00.000Z', deliveryDate: '2026-10-15' }, now)).toBe(false)
    expect(customerCanCancel({ status: 'out_for_delivery', deliveryMethod: 'local_delivery', orderBy: '2026-10-14T15:30:00.000Z', deliveryDate: '2026-10-15' }, now)).toBe(false)
  })
  it('lets a courier order be cancelled until it is sent, because it has no window or cut-off', () => {
    expect(customerCanCancel({ status: 'placed', deliveryMethod: 'shipping', orderBy: null, deliveryDate: '2026-10-14' }, now)).toBe(true)
    expect(customerCanCancel({ status: 'out_for_delivery', deliveryMethod: 'shipping', orderBy: null, deliveryDate: '2026-10-14' }, now)).toBe(false)
  })
  it('without a cut-off allows it until the delivery day starts in India', () => {
    expect(customerCanCancel({ status: 'placed', deliveryMethod: 'local_delivery', orderBy: null, deliveryDate: '2026-10-15' }, now)).toBe(true)
    expect(customerCanCancel({ status: 'placed', deliveryMethod: 'local_delivery', orderBy: null, deliveryDate: '2026-10-14' }, now)).toBe(false)
  })
})

describe('building orders from a cart', () => {
  it('merges the same size added twice and adds the quantities', () => {
    expect(mergeLines([{ variantId: 'a', quantity: 2 }, { variantId: 'b', quantity: 1 }, { variantId: 'a', quantity: 3 }])).toEqual([{ variantId: 'a', quantity: 5 }, { variantId: 'b', quantity: 1 }])
  })
  it('makes one order per delivery setup, in the same order however the cart was arranged', () => {
    const milk = line({ variantId: 'milk' })
    const curd = line({ variantId: 'curd', productId: 'p2' })
    const ghee = line({ variantId: 'ghee', productId: 'p3', deliveryMethod: 'shipping', serviceAreaId: 'india', cutoffRuleId: null })
    const groups = groupBySetup([ghee, milk, curd])
    expect(groups).toHaveLength(2)
    expect(groups.map(group => ids(group.lines).sort())).toContainEqual(['curd', 'milk'])
    expect(groups.map(group => ids(group.lines).sort())).toContainEqual(['ghee'])
    expect(groupBySetup([milk, ghee, curd]).map(group => group.key)).toEqual(groups.map(group => group.key))
  })
  it('adds up prices from the stored price times the quantity', () => {
    expect(subtotalPaise([line({ pricePaise: 3500 }, 2), line({ pricePaise: 6500 }, 1)])).toBe(13500)
  })
})

describe('credit', () => {
  it('is refused for an order holding a product marked not available on credit', () => {
    expect(creditEligible([line({}), line({ excludedFromCredit: true })])).toBe(false)
    expect(creditEligible([line({}), line({ variantId: 'x' })])).toBe(true)
  })
  it('stays within the limit: what is owed plus the new order, exactly up to the limit is fine', () => {
    expect(withinCreditLimit(100_000, 60_000, 40_000)).toBe(true)
    expect(withinCreditLimit(100_000, 60_000, 40_001)).toBe(false)
    expect(withinCreditLimit(0, 0, 1)).toBe(false)
  })
})

describe('the doorstep note on an order', () => {
  it('turns the customer wishes into one short line for the delivery person', () => {
    expect(doorstepNoteOf({ dropLocation: 'milk-box', handoff: 'leave-at-door', noDoorbell: true, noCall: true, notifyAfterDelivery: true, additionalInstructions: 'Dog in the garden' }))
      .toBe('Drop: Milk box. Leave at the door. Do not ring the bell. Do not call. Dog in the garden')
    expect(doorstepNoteOf({ dropLocation: 'front-door', handoff: 'hand-to-me', noDoorbell: false, noCall: false, notifyAfterDelivery: false, additionalInstructions: '' })).toBe('Drop: Front door. Hand it to the customer')
  })
  it('never exceeds the 300 characters an order note can hold', () => {
    expect(doorstepNoteOf({ dropLocation: 'front-door', handoff: 'hand-to-me', noDoorbell: true, noCall: true, notifyAfterDelivery: true, additionalInstructions: 'x'.repeat(300) }).length).toBe(300)
  })
})
