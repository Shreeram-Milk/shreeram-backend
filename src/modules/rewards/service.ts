import { randomInt } from 'node:crypto'
import { AppError } from '../../http/errors.js'
import type { ObjectStorage } from '../../integrations/storage/storage.js'
import type { AppSettingsService } from '../app-settings/service.js'
import { indiaClock } from '../delivery-brain/rules.js'
import { noopNotifier, type Notifier } from '../notifications/notifier.js'
import type { RewardRepository, RewardStats, StoredRewardCard } from './repository.js'

/** A scratch card as the app reads it: the picture is a short-lived link, never the storage key. */
export type RewardCard = Omit<StoredRewardCard, 'offer'> & { status: 'new' | 'scratched' | 'used' | 'expired'; offer: Omit<StoredRewardCard['offer'], 'imageKey'> & { imageUrl: string | null } }

type Dependencies = {
  repository: RewardRepository
  settings: Pick<AppSettingsService, 'get'>
  storage: Pick<ObjectStorage, 'createDownloadUrl'>
  notifier?: Notifier
  /** Picks a card's offer from the pool. Tests pass a fixed choice. */
  pick?: (count: number) => number
  now?: () => Date
}

const DAY_MS = 24 * 60 * 60 * 1000
const LIST_LIMIT = 50
const notFound = () => new AppError(404, 'REWARD_NOT_FOUND', 'That scratch card does not exist.')

/**
 * Scratch cards. A delivered one-time order of at least the set amount earns one free card; every card holds a real
 * money-off code picked at random from the pool (never a blank), shown only after the customer scratches it.
 * Nothing is paid to play and nothing has cash value, which keeps it a plain reward under Play Store rules.
 */
export function createRewardService({ repository, settings, storage, notifier = noopNotifier, pick = count => randomInt(count), now = () => new Date() }: Dependencies) {
  async function toCard(card: StoredRewardCard): Promise<RewardCard> {
    const { imageKey, ...offer } = card.offer
    const imageUrl = imageKey ? await storage.createDownloadUrl(imageKey) : null
    const status = card.usedAt ? 'used' : new Date(card.expiresAt).getTime() <= now().getTime() ? 'expired' : card.scratchedAt ? 'scratched' : 'new'
    return { ...card, status, offer: { ...offer, imageUrl } }
  }

  return {
    /**
     * After an order is marked delivered. Gives one card when rewards are on and the order qualifies. Safe to call again
     * for the same order (one card per order), and it never fails the delivery that called it.
     */
    async issueForOrder(orderId: string): Promise<void> {
      try {
        const current = await settings.get()
        if (!current.rewardsEnabled) return
        const order = await repository.findOrder(orderId)
        if (!order || order.fromPlan || order.status !== 'delivered' || order.totalPaise < current.rewardsMinOrderPaise) return
        const pool = await repository.poolOfferIds(indiaClock(now()).date)
        if (pool.length === 0) return
        const offerId = pool[pick(pool.length)] as string
        const cardId = await repository.create({ customerId: order.customerId, orderId, offerId, expiresAt: new Date(now().getTime() + current.rewardsExpiryDays * DAY_MS) })
        if (!cardId) return
        await notifier.notify({ event: 'reward_won', customerId: order.customerId, vars: { order: order.orderNumber }, link: `/rewards?cardId=${cardId}`, dedupeKey: `reward:${orderId}` })
      } catch {
        // The order is already delivered; a missed card must not undo or hide that.
      }
    },

    async listMine(customerId: string): Promise<RewardCard[]> {
      return Promise.all((await repository.listForCustomer(customerId, LIST_LIMIT)).map(toCard))
    },

    async getMine(customerId: string, cardId: string): Promise<RewardCard> {
      const card = await repository.findForCustomer(customerId, cardId)
      if (!card) throw notFound()
      return toCard(card)
    },

    /** Reveals the code. Scratching twice is harmless; an expired card that was never scratched stays closed. */
    async scratch(customerId: string, cardId: string): Promise<RewardCard> {
      const existing = await repository.findForCustomer(customerId, cardId)
      if (!existing) throw notFound()
      if (!existing.scratchedAt && new Date(existing.expiresAt).getTime() <= now().getTime()) throw new AppError(409, 'REWARD_EXPIRED', 'This scratch card has expired.')
      const card = await repository.scratch(customerId, cardId, now())
      if (!card) throw notFound()
      return toCard(card)
    },

    stats: (): Promise<RewardStats> => repository.stats(),
  }
}

export type RewardService = ReturnType<typeof createRewardService>
