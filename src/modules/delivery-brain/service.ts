import type { DeliveryMethod } from '../products/schema.js'
import type { BrainSetup, DeliveryBrainRepository } from './repository.js'
import { cancelMoment, earliestDelivery, type CutoffCondition } from './rules.js'

/** `cancelBy`: until when an order for `earliestDate` can still be cancelled by the customer. */
export type SlotOffer = { slotId: string; name: string; startTime: string; endTime: string; earliestDate: string; orderBy: string | null; cancelBy: string }
/** A slot offer with the cut-off condition behind it, for working out the lock time of any later date (subscriptions). */
export type SlotRule = SlotOffer & { condition: CutoffCondition | null }
export type SlotRules = { served: true; deliveryMethod: DeliveryMethod; slots: SlotRule[] } | { served: false; reason: NotServedReason }
export type NotServedReason = 'INVALID_PIN' | 'PRODUCT_UNAVAILABLE' | 'NOT_SERVED'
export type DeliveryCheck =
  | { served: true; deliveryMethod: DeliveryMethod; locality: string; slots: SlotOffer[] }
  | { served: false; reason: NotServedReason }
/** One way of delivering that serves a PIN, as the phone shows it. */
export type ServedOption = { optionId: string; name: string; deliveryMethod: DeliveryMethod; locality: string; slots: SlotOffer[] }

const PIN_CODE = /^[1-9][0-9]{5}$/
/** More distinct ways of delivering than this cannot exist in practice; the cap only keeps the question bounded. */
const MAX_SETUPS = 50
const notServed = (reason: NotServedReason): { served: false; reason: NotServedReason } => ({ served: false, reason })

type Dependencies = { repository: DeliveryBrainRepository; now?: () => Date }

/**
 * The one place that answers "can we deliver this product to this PIN, and when?". The phone asks; the server decides.
 * The answer depends on the clock, so it is never cached.
 */
export function createDeliveryBrainService({ repository, now = () => new Date() }: Dependencies) {
  /** Can this delivery setup serve this (already well-formed) PIN, and from when? */
  async function evaluate(profile: BrainSetup, pinCode: string): Promise<DeliveryCheck> {
    const result = await evaluateWithRules(profile, pinCode)
    if (!result.served) return result
    return { served: true, deliveryMethod: result.deliveryMethod, locality: result.locality, slots: result.slots.map(({ condition: _condition, ...slot }) => slot) }
  }

  async function evaluateWithRules(profile: BrainSetup, pinCode: string): Promise<{ served: true; deliveryMethod: DeliveryMethod; locality: string; slots: SlotRule[] } | { served: false; reason: NotServedReason }> {
    if (profile.area.status !== 'active') return notServed('PRODUCT_UNAVAILABLE')

    if (profile.deliveryMethod === 'shipping') {
      if (profile.area.coverageType === 'pan_india') return { served: true, deliveryMethod: 'shipping', locality: '', slots: [] }
      // A whole-state area needs the national directory to know which state the PIN is in; an unknown PIN cannot be confirmed.
      const states = await repository.directoryStates(pinCode)
      const wanted = profile.area.state.trim().toLowerCase()
      return states.some(state => state.trim().toLowerCase() === wanted) ? { served: true, deliveryMethod: 'shipping', locality: '', slots: [] } : notServed('NOT_SERVED')
    }

    const served = await repository.findServedPin(profile.area.id, pinCode)
    if (!served) return notServed('NOT_SERVED')
    const instant = now()
    const slots: SlotRule[] = served.slots.map(slot => {
      const found = profile.conditions.find(item => item.deliverySlotId === slot.slotId)
      const condition: CutoffCondition | null = found ? { dayRelation: found.dayRelation, cutoffTime: found.cutoffTime, cancelDayRelation: found.cancelDayRelation ?? null, cancelTime: found.cancelTime ?? null } : null
      const { date, orderBy } = earliestDelivery(slot, condition, instant)
      return { ...slot, earliestDate: date, orderBy, cancelBy: cancelMoment(date, condition).toISOString(), condition }
    })
    return { served: true, deliveryMethod: 'local_delivery', locality: served.locality, slots }
  }

  return {
    async check(pinCode: string, productId: string): Promise<DeliveryCheck> {
      if (!PIN_CODE.test(pinCode)) return notServed('INVALID_PIN')
      const setup = await repository.findProductSetup(productId)
      return setup ? evaluate(setup, pinCode) : notServed('PRODUCT_UNAVAILABLE')
    },

    /** Like `check`, with each slot's cut-off condition: subscriptions need the lock time of any later date, not just the first. */
    async slotRules(pinCode: string, productId: string): Promise<SlotRules> {
      if (!PIN_CODE.test(pinCode)) return notServed('INVALID_PIN')
      const setup = await repository.findProductSetup(productId)
      if (!setup) return notServed('PRODUCT_UNAVAILABLE')
      const result = await evaluateWithRules(setup, pinCode)
      return result.served ? { served: true, deliveryMethod: result.deliveryMethod, slots: result.slots } : result
    },

    /** Every way of delivering that serves this PIN, across the live products. The Location screen uses it before any product is chosen. */
    async servedOptions(pinCode: string): Promise<ServedOption[]> {
      if (!PIN_CODE.test(pinCode)) return []
      const setups = await repository.listActiveSetups(MAX_SETUPS)
      const results = await Promise.all(setups.map(async setup => ({ setup, result: await evaluate(setup, pinCode) })))
      return results.flatMap(({ setup, result }): ServedOption[] => result.served ? [{ optionId: setup.id, name: setup.name, deliveryMethod: result.deliveryMethod, locality: result.locality, slots: result.slots }] : [])
    },
  }
}

export type DeliveryBrainService = ReturnType<typeof createDeliveryBrainService>
