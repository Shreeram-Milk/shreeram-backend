import { describe, expect, it } from 'vitest'
import type { RewardOrder, RewardRepository, StoredRewardCard } from '../src/modules/rewards/repository.js'
import { createRewardService } from '../src/modules/rewards/service.js'
import type { NotifyInput } from '../src/modules/notifications/notifier.js'
import { DEFAULT_SETTINGS } from './fakes.js'

const NOW = new Date('2026-11-08T06:00:00.000Z')
const offer = (id: string): StoredRewardCard['offer'] => ({
  id, title: `Offer ${id}`, titleGu: '', description: '', descriptionGu: '', kind: 'percent', percent: 10, flatPaise: null, maxDiscountPaise: null, minOrderPaise: 0, endsOn: null,
  showText: true, points: [], imageKey: null, code: `CODE${id}`,
})

function setup(options: { enabled?: boolean; minPaise?: number; pool?: string[]; order?: Partial<RewardOrder> } = {}) {
  const cards: (StoredRewardCard & { customerId: string; orderId: string })[] = []
  const sent: NotifyInput[] = []
  const order: RewardOrder = { customerId: 'customer-1', orderNumber: 'SRM-1001', totalPaise: 50_000, status: 'delivered', fromPlan: false, ...options.order }
  const view = (card: (typeof cards)[number]): StoredRewardCard => ({ ...card, offer: { ...card.offer, code: card.scratchedAt ? card.offer.code : null } })
  const repository: RewardRepository = {
    async findOrder(orderId) { return orderId === 'order-1' ? order : null },
    async poolOfferIds() { return options.pool ?? ['a', 'b'] },
    async create(input) {
      if (cards.some(card => card.orderId === input.orderId)) return null
      const id = `card-${cards.length + 1}`
      cards.push({ id, customerId: input.customerId, orderId: input.orderId, orderNumber: 'SRM-1001', createdAt: NOW.toISOString(), expiresAt: input.expiresAt.toISOString(), scratchedAt: null, usedAt: null, offer: offer(input.offerId) })
      return id
    },
    async listForCustomer(customerId) { return cards.filter(card => card.customerId === customerId).map(view) },
    async scratch(customerId, cardId, now) {
      const card = cards.find(item => item.id === cardId && item.customerId === customerId)
      if (!card) return null
      card.scratchedAt ??= now.toISOString()
      return view(card)
    },
    async findForCustomer(customerId, cardId) { const card = cards.find(item => item.id === cardId && item.customerId === customerId); return card ? view(card) : null },
    async stats() { return { given: cards.length, scratched: cards.filter(card => card.scratchedAt).length, used: 0 } },
  }
  const settings = { get: async () => ({ ...DEFAULT_SETTINGS, rewardsEnabled: options.enabled ?? true, rewardsMinOrderPaise: options.minPaise ?? 0, rewardsExpiryDays: 30 }) }
  let clock = NOW
  const service = createRewardService({
    repository, settings, storage: { createDownloadUrl: async key => `https://example.test/${key}` }, notifier: { notify: async input => { sent.push(input) } },
    pick: () => 1, now: () => clock,
  })
  return { service, cards, sent, setClock: (date: Date) => { clock = date } }
}

describe('scratch cards', () => {
  it('gives one card per delivered order, from the pool, and tells the customer', async () => {
    const { service, cards, sent } = setup()
    await service.issueForOrder('order-1')
    await service.issueForOrder('order-1')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.offer.id).toBe('b')
    expect(cards[0]?.expiresAt).toBe('2026-12-08T06:00:00.000Z')
    expect(sent.map(item => [item.event, item.link])).toEqual([['reward_won', '/rewards?cardId=card-1']])
  })

  it('gives nothing when rewards are off, the pool is empty, the order is small, from a plan, or not delivered', async () => {
    for (const options of [{ enabled: false }, { pool: [] }, { minPaise: 60_000 }, { order: { fromPlan: true } }, { order: { status: 'placed' } }]) {
      const { service, cards } = setup(options)
      await service.issueForOrder('order-1')
      expect(cards).toHaveLength(0)
    }
  })

  it('hides the code until the card is scratched, and scratching twice keeps the first time', async () => {
    const { service, setClock } = setup()
    await service.issueForOrder('order-1')
    const [before] = await service.listMine('customer-1')
    expect(before).toMatchObject({ status: 'new', offer: { code: null } })
    const scratched = await service.scratch('customer-1', 'card-1')
    expect(scratched).toMatchObject({ status: 'scratched', scratchedAt: NOW.toISOString(), offer: { code: 'CODEb' } })
    setClock(new Date('2026-11-09T06:00:00.000Z'))
    expect((await service.scratch('customer-1', 'card-1')).scratchedAt).toBe(NOW.toISOString())
  })

  it('never shows another customer their card, and an expired card cannot be scratched', async () => {
    const { service, setClock } = setup()
    await service.issueForOrder('order-1')
    await expect(service.scratch('customer-2', 'card-1')).rejects.toMatchObject({ code: 'REWARD_NOT_FOUND' })
    setClock(new Date('2026-12-09T06:00:00.000Z'))
    await expect(service.scratch('customer-1', 'card-1')).rejects.toMatchObject({ code: 'REWARD_EXPIRED' })
    expect((await service.listMine('customer-1'))[0]?.status).toBe('expired')
  })
})
