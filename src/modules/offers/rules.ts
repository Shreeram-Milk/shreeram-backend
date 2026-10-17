import type { OfferInput, PurchaseKind } from './schema.js'

/** An offer as the rules see it. */
export type Offer = OfferInput & { id: string }

/** One line of a cart as an offer sees it: what it is, and what it costs before any offer. */
export type OfferLine = { productId: string; variantId: string; quantity: number; totalPaise: number }

export const OFFER_PROBLEMS = {
  OFFER_CODE_INVALID: 'That offer code is not valid.',
  OFFER_NOT_LIVE: 'That offer has ended or has not started yet.',
  OFFER_NOT_FOR_THIS: 'That offer does not apply to what is in your cart.',
  OFFER_LIMIT_REACHED: 'That offer has been used up.',
  OFFER_ALREADY_USED: 'You have already used that offer the most times allowed.',
} as const
export type OfferProblemCode = keyof typeof OFFER_PROBLEMS

/** Is today (India time, YYYY-MM-DD) inside the offer's dates, and is it switched on? */
export const isLive = (offer: Pick<Offer, 'status' | 'startsOn' | 'endsOn'>, today: string): boolean =>
  offer.status === 'active' && (!offer.startsOn || today >= offer.startsOn) && (!offer.endsOn || today <= offer.endsOn)

export const worksFor = (offer: Pick<Offer, 'appliesOneTime' | 'appliesTrial' | 'appliesSubscription'>, purchase: PurchaseKind): boolean =>
  purchase === 'one_time' ? offer.appliesOneTime : purchase === 'trial' ? offer.appliesTrial : offer.appliesSubscription

/** The part of the cart this offer counts: everything, or only the chosen products. */
export const eligibleLines = (offer: Pick<Offer, 'scope' | 'productIds'>, lines: OfferLine[]): OfferLine[] =>
  offer.scope === 'order' ? lines : lines.filter(line => offer.productIds.includes(line.productId))

export const sumPaise = (lines: OfferLine[]): number => lines.reduce((sum, line) => sum + line.totalPaise, 0)

/** The money off for the part of the cart that counts. Never more than that part costs. */
export function discountFor(offer: Pick<Offer, 'kind' | 'percent' | 'flatPaise' | 'maxDiscountPaise'>, eligiblePaise: number): number {
  if (eligiblePaise <= 0) return 0
  let discount = 0
  if (offer.kind === 'percent' && offer.percent !== null) discount = Math.floor((eligiblePaise * offer.percent) / 100)
  if (offer.kind === 'flat' && offer.flatPaise !== null) discount = offer.flatPaise
  if (offer.maxDiscountPaise !== null) discount = Math.min(discount, offer.maxDiscountPaise)
  return Math.min(discount, eligiblePaise)
}

/**
 * Splits a discount across the orders of one checkout in proportion to what each order costs, in whole paise
 * (largest remainder), so the parts always add up to exactly the discount.
 */
export function distributeDiscount(discount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (discount <= 0 || total <= 0) return weights.map(() => 0)
  const exact = weights.map(weight => (discount * weight) / total)
  const parts = exact.map(Math.floor)
  let left = discount - parts.reduce((sum, part) => sum + part, 0)
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const { index } of byRemainder) {
    if (left <= 0) break
    parts[index] = (parts[index] ?? 0) + 1
    left -= 1
  }
  return parts
}
