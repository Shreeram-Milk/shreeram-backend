import { isFinal, type PlanWarning, type SlotClosing } from './rules.js'

/** One piece of an order a rider hands over. Gifts are included: they travel in the same crate. */
export type RiderItem = { productId: string; variantId: string; productName: string; variantName: string; quantity: number }
/** One house to visit, as the database gave it. */
export type RiderStopRow = {
  orderId: string; orderNumber: string; recipientName: string; recipientPhone: string
  addressLine1: string; addressLine2: string; landmark: string; city: string; pinCode: string; doorstepNote: string
  kind: 'one_time' | 'subscription' | 'trial'; items: RiderItem[]
}
/** How many of one product size to load. */
export type LoadLine = RiderItem
/** One PIN code on the sheet: its houses in visiting order and what to keep aside for them. */
export type RiderArea = { pinCode: string; city: string; stops: RiderStopRow[]; load: LoadLine[] }
export type RiderSheetSlot = { slotId: string; name: string; startTime: string; endTime: string }
export type RiderSheet = {
  date: string; slot: RiderSheetSlot
  /** "final" once nobody can order into or cancel from this window any more; the same rule as production planning. */
  status: 'open' | 'final'; closesAt: string | null
  areas: RiderArea[]; load: LoadLine[]; stopCount: number
  /** True when the window had more open orders than one sheet holds; the sheet then lists only the first ones. */
  truncated: boolean
  warnings: PlanWarning[]
}

/** The most houses one sheet lists. A delivery window far beyond this is not expected; the sheet says so when it happens. */
export const RIDER_SHEET_LIMIT = 2000

/** Society or street names typed by customers differ in case and spacing; this makes "Shyam  flats" sort with "Shyam Flats". */
const normalized = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN')
const natural = (a: string, b: string) => normalized(a).localeCompare(normalized(b), 'en-IN', { numeric: true })

/** Within one PIN code: the same society or street together, then flat numbers in counting order (B-2 before B-10), then name. */
const visitingOrder = (a: RiderStopRow, b: RiderStopRow) =>
  natural(a.addressLine2, b.addressLine2) || natural(a.addressLine1, b.addressLine1) || natural(a.recipientName, b.recipientName) || a.orderNumber.localeCompare(b.orderNumber)

function loadOf(stops: RiderStopRow[]): LoadLine[] {
  const lines = new Map<string, LoadLine>()
  for (const stop of stops) for (const item of stop.items) {
    const key = `${item.productId}|${item.variantId}`
    const line = lines.get(key)
    if (line) line.quantity += item.quantity
    else lines.set(key, { productId: item.productId, variantId: item.variantId, productName: item.productName, variantName: item.variantName, quantity: item.quantity })
  }
  return [...lines.values()].sort((a, b) => a.productName.localeCompare(b.productName) || natural(a.variantName, b.variantName))
}

/**
 * The rider sheet for one delivery window: every open local delivery, one section per PIN code (lowest first), houses in
 * visiting order, and what to load for each section and for the whole sheet. Pure, so it is easy to test.
 */
export function buildRiderSheet(input: { date: string; slot: RiderSheetSlot; stops: RiderStopRow[]; closing: SlotClosing | null; truncated: boolean; warnings: PlanWarning[]; now: Date }): RiderSheet {
  const byPin = new Map<string, RiderStopRow[]>()
  for (const stop of input.stops) byPin.set(stop.pinCode, [...(byPin.get(stop.pinCode) ?? []), stop])
  const areas = [...byPin]
    .sort(([a], [b]) => a.localeCompare(b, 'en-IN', { numeric: true }))
    .map(([pinCode, stops]): RiderArea => {
      const ordered = [...stops].sort(visitingOrder)
      return { pinCode, city: ordered.find(stop => stop.city)?.city ?? '', stops: ordered, load: loadOf(ordered) }
    })
  const closesAt = input.closing?.closesAt ?? null
  return {
    date: input.date, slot: input.slot, status: isFinal(input.date, closesAt, input.now) ? 'final' : 'open', closesAt,
    areas, load: loadOf(input.stops), stopCount: input.stops.length, truncated: input.truncated, warnings: input.warnings,
  }
}
