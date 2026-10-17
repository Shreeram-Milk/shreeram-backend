import { randomUUID } from 'node:crypto'
import type { OfferRepository, OfferUsage, StoredOffer } from '../src/modules/offers/repository.js'
import type { OfferInput } from '../src/modules/offers/schema.js'

export type FakeRedemption = { offerId: string; customerId: string; checkoutKey: string; orderId: string | null; subscriptionId: string | null; discountPaise: number }

/** Offers kept in memory for tests, with the same rules as the Postgres version. */
export function createFakeOfferRepository(now: () => Date) {
  const rows: StoredOffer[] = []
  const redemptions: FakeRedemption[] = []
  /** Sizes that are on sale and their prices; a gift whose size is missing counts as switched off. */
  const giftsOnSale = new Map<string, number>()
  const stamp = () => now().toISOString()

  const usageOf = (offerId: string, customerId: string, exceptCheckout?: string): OfferUsage => {
    const used = redemptions.filter(item => item.offerId === offerId && item.checkoutKey !== exceptCheckout)
    return { total: new Set(used.map(item => item.checkoutKey)).size, mine: new Set(used.filter(item => item.customerId === customerId).map(item => item.checkoutKey)).size }
  }

  const repository: OfferRepository = {
    async list() { return [...rows].reverse() },
    async findById(id) { return rows.find(offer => offer.id === id) ?? null },
    async listLive(today) { return rows.filter(offer => offer.status === 'active' && (!offer.startsOn || offer.startsOn <= today) && (!offer.endsOn || offer.endsOn >= today)).reverse() },
    async findByCode(code) { return rows.find(offer => offer.code === code) ?? null },
    async create(input: OfferInput) {
      if (input.code && rows.some(offer => offer.code === input.code)) throw Object.assign(new Error('duplicate key'), { code: '23505' })
      const offer: StoredOffer = { ...input, id: randomUUID(), giftLabel: input.giftVariantId ? 'Gift' : null, giftProductId: null, createdAt: stamp(), updatedAt: stamp() }
      rows.push(offer)
      return offer
    },
    async update(id, input) {
      const offer = rows.find(item => item.id === id)
      if (!offer) return null
      if (input.code && rows.some(other => other.id !== id && other.code === input.code)) throw Object.assign(new Error('duplicate key'), { code: '23505' })
      Object.assign(offer, input, { updatedAt: stamp() })
      return offer
    },
    async setStatus(id, status) {
      const offer = rows.find(item => item.id === id)
      if (!offer) return null
      offer.status = status
      return offer
    },
    async usage(offerIds, customerId) { return new Map(offerIds.map(id => [id, usageOf(id, customerId)])) },
    async giftPricePaise(variantId) { return giftsOnSale.get(variantId) ?? null },
  }
  return { repository, rows, redemptions, usageOf, giftsOnSale }
}
