import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import { indiaClock } from '../delivery-brain/rules.js'
import type { OfferRepository, OfferUsage, StoredOffer } from './repository.js'
import { OFFER_PROBLEMS, discountFor, eligibleLines, isLive, sumPaise, worksFor, type OfferLine, type OfferProblemCode } from './rules.js'
import type { OfferInput, PurchaseKind } from './schema.js'

type Dependencies = { repository: OfferRepository; audit: AuditWriter; now?: () => Date }
type Actor = { adminId: string; ip: string | null }

/** What a checkout needs to know about the offer it used. Written to the order, so it never changes afterwards. */
export type AppliedOffer = {
  offerId: string; title: string; titleGu: string; code: string | null; discountPaise: number
  /** A free gift offer: the size to add at no charge, how many, and which products in the cart earned it (the gift travels with one of them). */
  gift?: { variantId: string; quantity: number; triggerProductIds: string[]; valuePaise: number }
}
export type OfferProblem = { code: OfferProblemCode | 'OFFER_MIN_ORDER'; message: string; details?: unknown }
export type OfferEvaluation = { applied: AppliedOffer | null; problem: OfferProblem | null }

/** What the customer app shows on the Offers page. No status, no limits, nothing internal. */
export type PublicOffer = Pick<StoredOffer, 'id' | 'title' | 'titleGu' | 'description' | 'descriptionGu' | 'kind' | 'percent' | 'flatPaise' | 'maxDiscountPaise' | 'minOrderPaise' | 'code' | 'endsOn' | 'appliesOneTime' | 'appliesTrial' | 'appliesSubscription' | 'minPlanDays'>

export type EvaluateInput = { customerId: string; lines: OfferLine[]; purchase: PurchaseKind; code?: string | undefined; planDays?: number | undefined }

const notFound = () => new AppError(404, 'OFFER_NOT_FOUND', 'That offer does not exist.')
const isDatabaseError = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === code
const ANYONE = '00000000-0000-0000-0000-000000000000'

const toPublic = (offer: StoredOffer): PublicOffer => ({
  id: offer.id, title: offer.title, titleGu: offer.titleGu, description: offer.description, descriptionGu: offer.descriptionGu, kind: offer.kind, percent: offer.percent, flatPaise: offer.flatPaise,
  maxDiscountPaise: offer.maxDiscountPaise, minOrderPaise: offer.minOrderPaise, code: offer.code, endsOn: offer.endsOn,
  appliesOneTime: offer.appliesOneTime, appliesTrial: offer.appliesTrial, appliesSubscription: offer.appliesSubscription, minPlanDays: offer.minPlanDays,
})

/**
 * Offers: staff create and switch them; checkout asks `evaluate` which offer (if any) the cart gets. One offer per checkout:
 * a code the customer typed, otherwise the live automatic offer that takes the most off. The server decides every amount.
 */
export function createOfferService({ repository, audit, now = () => new Date() }: Dependencies) {
  const todayIndia = () => indiaClock(now()).date

  /** Does this offer give this cart anything? Returns the discount, or the reason it does not. */
  async function check(offer: StoredOffer, usage: OfferUsage, input: EvaluateInput): Promise<{ discountPaise: number; gift?: AppliedOffer['gift'] } | { problem: OfferProblem }> {
    const refuse = (code: OfferProblemCode | 'OFFER_MIN_ORDER', message: string = OFFER_PROBLEMS[code as OfferProblemCode], details?: unknown): { problem: OfferProblem } => ({ problem: { code, message, details } })
    if (!isLive(offer, todayIndia())) return refuse('OFFER_NOT_LIVE')
    if (!worksFor(offer, input.purchase)) return refuse('OFFER_NOT_FOR_THIS')
    if (input.purchase === 'subscription' && offer.minPlanDays !== null && (input.planDays ?? 0) < offer.minPlanDays) return refuse('OFFER_NOT_FOR_THIS')
    if (offer.totalLimit !== null && usage.total >= offer.totalLimit) return refuse('OFFER_LIMIT_REACHED')
    if (offer.perCustomerLimit !== null && usage.mine >= offer.perCustomerLimit) return refuse('OFFER_ALREADY_USED')
    // A gift is earned by buying one of the chosen products; money-off offers count everything or only the chosen products.
    const eligible = offer.kind === 'free_gift' ? input.lines.filter(line => offer.productIds.includes(line.productId)) : eligibleLines(offer, input.lines)
    if (eligible.length === 0) return refuse('OFFER_NOT_FOR_THIS')
    const eligiblePaise = sumPaise(eligible)
    if (eligiblePaise < offer.minOrderPaise) {
      const shortByPaise = offer.minOrderPaise - eligiblePaise
      return refuse('OFFER_MIN_ORDER', 'Add a little more to your cart to use this offer.', { minOrderPaise: offer.minOrderPaise, shortByPaise })
    }
    if (offer.kind === 'free_gift') {
      // The gift is free only here. If it is switched off or out of sale, the offer is simply not available.
      const price = offer.giftVariantId ? await repository.giftPricePaise(offer.giftVariantId) : null
      if (price === null || !offer.giftVariantId) return refuse('OFFER_NOT_FOR_THIS')
      return { discountPaise: 0, gift: { variantId: offer.giftVariantId, quantity: offer.giftQuantity, triggerProductIds: eligible.map(line => line.productId), valuePaise: price * offer.giftQuantity } }
    }
    const discountPaise = discountFor(offer, eligiblePaise)
    return discountPaise > 0 ? { discountPaise } : refuse('OFFER_NOT_FOR_THIS')
  }

  const applied = (offer: StoredOffer, result: { discountPaise: number; gift?: AppliedOffer['gift'] }): AppliedOffer =>
    ({ offerId: offer.id, title: offer.title, titleGu: offer.titleGu, code: offer.code, discountPaise: result.discountPaise, ...(result.gift ? { gift: result.gift } : {}) })

  /** Saves, turning a clash with a database rule into something staff can act on. */
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error) {
      if (isDatabaseError(error, '23505')) throw new AppError(409, 'OFFER_CODE_TAKEN', 'Another offer already uses that code. Choose a different code.')
      if (isDatabaseError(error, '23503')) throw new AppError(400, 'OFFER_PRODUCT_NOT_FOUND', 'A product or size chosen for this offer no longer exists. Choose again.')
      throw error
    }
  }

  async function checkGift(input: OfferInput): Promise<void> {
    if (input.kind === 'free_gift' && input.giftVariantId && input.status === 'active' && (await repository.giftPricePaise(input.giftVariantId)) === null) {
      throw new AppError(409, 'OFFER_GIFT_UNAVAILABLE', 'The free product is switched off or not on sale. Choose another product, or switch the offer off.')
    }
  }

  return {
    list: () => repository.list(),

    async get(id: string): Promise<StoredOffer> {
      const offer = await repository.findById(id)
      if (!offer) throw notFound()
      return offer
    },

    async create(input: OfferInput, actor: Actor): Promise<StoredOffer> {
      await checkGift(input)
      const offer = await guarded(() => repository.create(input))
      await audit({ adminId: actor.adminId, action: 'offer_created', details: { offerId: offer.id }, ip: actor.ip })
      return offer
    },

    async update(id: string, input: OfferInput, actor: Actor): Promise<StoredOffer> {
      await checkGift(input)
      const offer = await guarded(() => repository.update(id, input))
      if (!offer) throw notFound()
      await audit({ adminId: actor.adminId, action: 'offer_updated', details: { offerId: id }, ip: actor.ip })
      return offer
    },

    async setStatus(id: string, status: 'active' | 'inactive', actor: Actor): Promise<StoredOffer> {
      const current = await repository.findById(id)
      if (!current) throw notFound()
      if (status === 'active') await checkGift({ ...current, code: current.code, status })
      const offer = await repository.setStatus(id, status)
      if (!offer) throw notFound()
      await audit({ adminId: actor.adminId, action: 'offer_status_changed', details: { offerId: id, status }, ip: actor.ip })
      return offer
    },

    /** The offers the customer app lists: live, not used up, and (for a gift) with the gift still on sale. */
    async listPublic(): Promise<PublicOffer[]> {
      const live = await repository.listLive(todayIndia())
      const usage = await repository.usage(live.map(offer => offer.id), ANYONE)
      const shown: PublicOffer[] = []
      for (const offer of live) {
        if (offer.totalLimit !== null && (usage.get(offer.id)?.total ?? 0) >= offer.totalLimit) continue
        if (offer.kind === 'free_gift' && !(offer.giftVariantId && (await repository.giftPricePaise(offer.giftVariantId)) !== null)) continue
        shown.push(toPublic(offer))
      }
      return shown
    },

    /**
     * Which offer does this cart get? With a code: that offer, or the reason it does not work. Without one: the automatic
     * offer (no code) that is worth the most (money off, or the price of the free gift), or none.
     */
    async evaluate(input: EvaluateInput): Promise<OfferEvaluation> {
      const code = input.code?.trim().toUpperCase()
      if (code) {
        const offer = await repository.findByCode(code)
        if (!offer) return { applied: null, problem: { code: 'OFFER_CODE_INVALID', message: OFFER_PROBLEMS.OFFER_CODE_INVALID } }
        const usage = (await repository.usage([offer.id], input.customerId)).get(offer.id) ?? { total: 0, mine: 0 }
        const result = await check(offer, usage, input)
        return 'problem' in result ? { applied: null, problem: result.problem } : { applied: applied(offer, result), problem: null }
      }
      const live = (await repository.listLive(todayIndia())).filter(offer => offer.code === null)
      if (live.length === 0) return { applied: null, problem: null }
      const usage = await repository.usage(live.map(offer => offer.id), input.customerId)
      let best: { offer: StoredOffer; result: { discountPaise: number; gift?: AppliedOffer['gift'] }; worth: number } | null = null
      for (const offer of live) {
        const result = await check(offer, usage.get(offer.id) ?? { total: 0, mine: 0 }, input)
        if ('problem' in result) continue
        const worth = result.discountPaise + (result.gift?.valuePaise ?? 0)
        if (!best || worth > best.worth) best = { offer, result, worth }
      }
      return { applied: best ? applied(best.offer, best.result) : null, problem: null }
    },
  }
}

export type OfferService = ReturnType<typeof createOfferService>
