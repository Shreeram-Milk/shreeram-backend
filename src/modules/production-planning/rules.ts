/** One line of demand: how much of one size of one product is wanted in one delivery window, in what production unit. */
export type DemandRow = {
  slotId: string; slotName: string; startTime: string; endTime: string
  productId: string; productName: string; variantId: string; variantName: string
  /** How many pieces customers bought, and in how many orders. */
  quantity: number; orderCount: number
  /** What those pieces need in the production unit (for example 0.5 Litre each), already added up. */
  productionUnit: string; productionQuantity: number
  /** The same pieces split by how they were bought. Left out, everything counts as one-time. */
  byType?: TypeSplit
  /** Pieces that were wanted but cancelled or skipped (not counted above), so staff can see what dropped out. */
  cancelledQuantity?: number
}
/** Pieces by how they were bought: a one-time purchase, a trial or a subscription. */
export type TypeSplit = { oneTime: number; trial: number; subscription: number }
/** When ordering for a window closes (the latest order-by time among its orders), or null when it has no cut-off. */
export type SlotClosing = { slotId: string; closesAt: string | null; orderCount?: number }

export type UnitTotal = { unit: string; quantity: number }
export type PlannedVariant = { variantId: string; variantName: string; quantity: number; orderCount: number; production: UnitTotal | null; byType: TypeSplit; cancelledQuantity: number }
export type PlannedProduct = { productId: string; productName: string; variants: PlannedVariant[]; production: UnitTotal[]; quantity: number; byType: TypeSplit; cancelledQuantity: number }
export type PlannedSlot = {
  slotId: string; slotName: string; startTime: string; endTime: string
  /** "open" while customers can still order for it (the amounts may grow); "final" once its order-by time has passed. */
  status: 'open' | 'final'; closesAt: string | null
  products: PlannedProduct[]; production: UnitTotal[]
  /** Pieces to make in this window, split by how they were bought, and pieces cancelled or skipped. */
  quantity: number; byType: TypeSplit; cancelledQuantity: number
  /** Orders still wanted in this window (each counted once, whatever is in it). */
  orderCount: number
}
export type ProductionPlan = { date: string; slots: PlannedSlot[] }

const round = (value: number) => Math.round(value * 1000) / 1000
const emptySplit = (): TypeSplit => ({ oneTime: 0, trial: 0, subscription: 0 })
function addSplit(target: TypeSplit, more: TypeSplit) { target.oneTime += more.oneTime; target.trial += more.trial; target.subscription += more.subscription }

function addTo(totals: Map<string, number>, unit: string, quantity: number) {
  totals.set(unit, round((totals.get(unit) ?? 0) + quantity))
}
const toList = (totals: Map<string, number>): UnitTotal[] => [...totals].filter(([, quantity]) => quantity > 0).map(([unit, quantity]) => ({ unit, quantity })).sort((a, b) => a.unit.localeCompare(b.unit))

/**
 * How much to make for one delivery day: demand per window, per product and size, and the total in each production unit.
 * Pure arithmetic over the rows the database gave, so it is easy to test.
 */
export function buildProductionPlan(date: string, rows: DemandRow[], closings: SlotClosing[], now: Date): ProductionPlan {
  const closesBySlot = new Map(closings.map(closing => [closing.slotId, closing.closesAt]))
  const ordersBySlot = new Map(closings.map(closing => [closing.slotId, closing.orderCount ?? 0]))
  const slots = new Map<string, { slot: PlannedSlot; units: Map<string, number>; products: Map<string, { product: PlannedProduct; units: Map<string, number> }> }>()
  for (const row of rows) {
    let entry = slots.get(row.slotId)
    if (!entry) {
      const closesAt = closesBySlot.get(row.slotId) ?? null
      entry = {
        slot: { slotId: row.slotId, slotName: row.slotName, startTime: row.startTime, endTime: row.endTime, closesAt, status: closesAt && now.getTime() >= new Date(closesAt).getTime() ? 'final' : 'open', products: [], production: [], quantity: 0, byType: emptySplit(), cancelledQuantity: 0, orderCount: ordersBySlot.get(row.slotId) ?? 0 },
        units: new Map(), products: new Map(),
      }
      slots.set(row.slotId, entry)
    }
    let product = entry.products.get(row.productId)
    if (!product) {
      product = { product: { productId: row.productId, productName: row.productName, variants: [], production: [], quantity: 0, byType: emptySplit(), cancelledQuantity: 0 }, units: new Map() }
      entry.products.set(row.productId, product)
      entry.slot.products.push(product.product)
    }
    const hasUnit = row.productionUnit !== '' && row.productionQuantity > 0
    const byType = row.byType ?? { oneTime: row.quantity, trial: 0, subscription: 0 }
    const cancelledQuantity = row.cancelledQuantity ?? 0
    product.product.variants.push({ variantId: row.variantId, variantName: row.variantName, quantity: row.quantity, orderCount: row.orderCount, production: hasUnit ? { unit: row.productionUnit, quantity: round(row.productionQuantity) } : null, byType: { ...byType }, cancelledQuantity })
    for (const target of [product.product, entry.slot]) {
      target.quantity += row.quantity
      target.cancelledQuantity += cancelledQuantity
      addSplit(target.byType, byType)
    }
    if (hasUnit) {
      addTo(product.units, row.productionUnit, row.productionQuantity)
      addTo(entry.units, row.productionUnit, row.productionQuantity)
    }
  }
  const planned = [...slots.values()].map(({ slot, units, products }) => {
    for (const { product, units: productUnits } of products.values()) product.production = toList(productUnits)
    slot.products.sort((a, b) => a.productName.localeCompare(b.productName))
    return { ...slot, production: toList(units) }
  })
  planned.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.slotName.localeCompare(b.slotName))
  return { date, slots: planned }
}
