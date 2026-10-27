import { instantAt } from '../delivery-brain/rules.js'
import type { DeliveryMethod } from '../products/schema.js'

export const ORDER_STATUSES = ['placed', 'out_for_delivery', 'delivered', 'missed', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** The legal steps an order can take. Delivered, missed and cancelled are final. */
const NEXT_STATUSES: Record<OrderStatus, readonly OrderStatus[]> = {
  placed: ['out_for_delivery', 'missed', 'cancelled'],
  out_for_delivery: ['delivered', 'missed', 'cancelled'],
  delivered: [],
  missed: [],
  cancelled: [],
}
export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => NEXT_STATUSES[from].includes(to)

/**
 * Only a cancelled order gives the customer's money back by itself (credit charge reversed, or a refund noted for staff).
 * A missed delivery does not: whether to refund or credit it is a staff decision, made separately ("return money").
 */
export const releasesMoney = (to: OrderStatus): boolean => to === 'cancelled'

/** Staff may return the money for a delivery that went wrong (missed) or that the customer was unhappy with (delivered). Once. */
export const canReturnMoney = (status: OrderStatus): boolean => status === 'missed' || status === 'delivered'

/**
 * A customer may cancel their own order only while it is still `placed` and ordering for it is still open:
 * before its order-by time, or, when there is no cut-off, before the delivery day begins (India time).
 * A courier order can be cancelled until it is sent.
 */
export function customerCanCancel(order: { status: OrderStatus; deliveryMethod: DeliveryMethod; orderBy: string | null; cancelBy?: string | null; deliveryDate: string }, now: Date): boolean {
  if (order.status !== 'placed') return false
  // A courier order has no delivery window or cut-off: it can be cancelled until staff send it.
  if (order.deliveryMethod === 'shipping') return true
  // The cancel deadline saved with the order; older orders fall back to their order-by time, then midnight of the delivery day.
  const closesAt = order.cancelBy ? new Date(order.cancelBy) : order.orderBy ? new Date(order.orderBy) : instantAt(order.deliveryDate, '00:00')
  return now.getTime() < closesAt.getTime()
}

/** What one cart line needs to be priced and grouped. Read from the database, never from the phone. */
export type CheckoutVariant = {
  variantId: string; variantName: string; pricePaise: number; variantActive: boolean
  productId: string; productName: string; productNameGu: string; productActive: boolean; categoryActive: boolean
  purchaseMethods: readonly string[]
  deliveryMethod: DeliveryMethod | null; serviceAreaId: string | null; cutoffRuleId: string | null
  includeInProductionPlanning: boolean; excludedFromCredit: boolean; productionUnit: string; productionQuantity: number
}
export type CartLine = { variant: CheckoutVariant; quantity: number; slotId?: string }

/** The same variant twice becomes one line and the quantities add up (the phone may send one size from two places). */
export function mergeLines(lines: ReadonlyArray<{ variantId: string; quantity: number; slotId?: string }>): Array<{ variantId: string; quantity: number; slotId?: string }> {
  const merged = new Map<string, { variantId: string; quantity: number; slotId?: string }>()
  for (const line of lines) {
    const key = `${line.variantId}:${line.slotId ?? ''}`
    const existing = merged.get(key)
    merged.set(key, { ...line, quantity: (existing?.quantity ?? 0) + line.quantity })
  }
  return [...merged.values()]
}

/** The key of a delivery setup: method, area and cut-off rule. Products sharing it travel together, so they share an order. */
export const setupKeyOf = (variant: Pick<CheckoutVariant, 'deliveryMethod' | 'serviceAreaId' | 'cutoffRuleId'>): string =>
  `${variant.deliveryMethod}:${variant.serviceAreaId}:${variant.cutoffRuleId ?? 'none'}`

export type OrderGroup = { key: string; deliveryMethod: DeliveryMethod; serviceAreaId: string; lines: CartLine[] }

/** One order per delivery setup, in a fixed order so the same cart always gives the same orders (needed for safe retries). */
export function groupBySetup(lines: CartLine[]): OrderGroup[] {
  const groups = new Map<string, OrderGroup>()
  for (const line of lines) {
    const { deliveryMethod, serviceAreaId } = line.variant
    if (!deliveryMethod || !serviceAreaId) throw new Error('A cart line without a delivery setup cannot be grouped.')
    const key = `${setupKeyOf(line.variant)}${line.slotId && deliveryMethod === 'local_delivery' ? `:${line.slotId}` : ''}`
    const group = groups.get(key)
    if (group) group.lines.push(line)
    else groups.set(key, { key, deliveryMethod, serviceAreaId, lines: [line] })
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export const lineTotalPaise = (line: CartLine): number => line.variant.pricePaise * line.quantity
export const subtotalPaise = (lines: CartLine[]): number => lines.reduce((sum, line) => sum + lineTotalPaise(line), 0)

/** An order can go on credit only when none of its products is marked "not available on credit". */
export const creditEligible = (lines: CartLine[]): boolean => lines.every(line => !line.variant.excludedFromCredit)

/** Credit stays within the limit: what is already owed plus this new amount must not go over it. */
export const withinCreditLimit = (limitPaise: number, owedPaise: number, newPaise: number): boolean => owedPaise + newPaise <= limitPaise

export type DoorstepPreferences = {
  dropLocation: 'front-door' | 'side-gate' | 'milk-box' | 'security-desk'
  handoff: 'hand-to-me' | 'leave-at-door' | 'milk-box' | 'security'
  noDoorbell: boolean; noCall: boolean; notifyAfterDelivery: boolean; additionalInstructions: string
}
const DROP_TEXT: Record<DoorstepPreferences['dropLocation'], string> = { 'front-door': 'Front door', 'side-gate': 'Side gate', 'milk-box': 'Milk box', 'security-desk': 'Security desk' }
const HANDOFF_TEXT: Record<DoorstepPreferences['handoff'], string> = { 'hand-to-me': 'Hand it to the customer', 'leave-at-door': 'Leave at the door', 'milk-box': 'Put in the milk box', security: 'Give to security' }

/** The customer's doorstep wishes as one short line for the delivery person, kept inside the order's 300-character note. */
export function doorstepNoteOf(preferences: DoorstepPreferences): string {
  const parts = [`Drop: ${DROP_TEXT[preferences.dropLocation]}`, HANDOFF_TEXT[preferences.handoff]]
  if (preferences.noDoorbell) parts.push('Do not ring the bell')
  if (preferences.noCall) parts.push('Do not call')
  if (preferences.additionalInstructions) parts.push(preferences.additionalInstructions)
  return parts.join('. ').slice(0, 300)
}
