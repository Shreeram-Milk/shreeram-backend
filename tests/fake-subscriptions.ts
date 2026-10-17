import { randomUUID } from 'node:crypto'
import { AppError } from '../src/http/errors.js'
import type { Customer } from '../src/modules/customer-auth/repository.js'
import type { Product } from '../src/modules/products/repository.js'
import type { SubscriptionRule } from '../src/modules/subscription-rules/repository.js'
import type { TrialPlan } from '../src/modules/trial-plans/repository.js'
import type { StoredPause, SubscriptionActivity, SubscriptionDraft, SubscriptionRecord, SubscriptionRepository, SubscriptionStatus } from '../src/modules/subscriptions/repository.js'
import { overlapsPause } from '../src/modules/subscriptions/rules.js'
import type { FakeRedemption } from './fake-offers.js'
import type { createFakeOrderRepository } from './fakes.js'

type StoredSubscription = Omit<SubscriptionRecord, 'customerName' | 'customerPhone' | 'pauses' | 'skips' | 'deliveries'> & { idempotencyKey: string | null }

/**
 * Subscriptions in memory with the same rules as the Postgres version. Skips live in the order fake's list, so a cancelled
 * subscription order and the subscription see the same skips; delivery orders are the order fake's own orders.
 */
export function createFakeSubscriptionRepository(stores: {
  orders: ReturnType<typeof createFakeOrderRepository>; customers: Map<string, Customer>; now: () => Date
  products: { rows: Product[] }; rules: { rows: SubscriptionRule[] }; trialPlans: { rows: TrialPlan[] }
  slots?: { rows: Array<{ id: string; name: string; startTime: string; endTime: string }> }
  offers?: { redemptions: FakeRedemption[] }
}) {
  const subscriptions: StoredSubscription[] = []
  const pauses: Array<StoredPause & { subscriptionId: string }> = []
  const activity: Array<{ subscriptionId: string; kind: string; detail: Record<string, unknown>; createdAt: string; adminId: string | null }> = []
  let counter = 1000

  const act = (subscriptionId: string, kind: string, detail: Record<string, unknown> = {}, adminId: string | null = null) => {
    activity.push({ subscriptionId, kind, detail, createdAt: stores.now().toISOString(), adminId })
  }
  const recordOf = ({ idempotencyKey: _key, ...row }: StoredSubscription): SubscriptionRecord => {
    const base = row
    const customer = stores.customers.get(row.customerId)
    return {
      // The window follows the slot as it is now; what was saved when the subscription started is only a fallback.
      ...base, lines: row.lines.map(line => { const current = stores.slots?.rows.find(item => item.id === line.slotId); return current ? { ...line, slotName: current.name, startTime: current.startTime, endTime: current.endTime } : { ...line } }), weekdays: [...row.weekdays],
      customerName: customer?.name ?? '', customerPhone: customer?.phone ?? '',
      pauses: pauses.filter(pause => pause.subscriptionId === row.id).sort((a, b) => a.fromDate.localeCompare(b.fromDate)).map(({ id, fromDate, untilDate }) => ({ id, fromDate, untilDate })),
      skips: stores.orders.skips.filter(skip => skip.subscriptionId === row.id).sort((a, b) => a.date.localeCompare(b.date)).map(({ lineId, date, reason }) => ({ lineId, date, reason })),
      deliveries: stores.orders.orders.filter(order => order.subscriptionId === row.id).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.orderNumber.localeCompare(b.orderNumber))
        .map(order => ({ orderId: order.id, orderNumber: order.orderNumber, lineId: order.subscriptionLineId as string, date: order.deliveryDate, status: order.status })),
    }
  }
  const activeRow = (id: string): StoredSubscription => {
    const row = subscriptions.find(item => item.id === id)
    if (!row || row.status !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
    return row
  }

  /** Also used by the payment fake when an online subscription payment settles. */
  function insert(draft: SubscriptionDraft, paymentId: string | null): string {
    if (draft.idempotencyKey && subscriptions.some(item => item.customerId === draft.customerId && item.idempotencyKey === draft.idempotencyKey)) throw Object.assign(new Error('duplicate key'), { code: '23505' })
    if (draft.kind === 'trial' && subscriptions.some(item => item.customerId === draft.customerId && item.productId === draft.productId && item.kind === 'trial' && item.status === 'active')) throw Object.assign(new Error('duplicate trial'), { code: '23505' })
    const id = randomUUID()
    const { customerId, idempotencyKey, lines, offer, ...rest } = draft
    subscriptions.push({
      ...rest, offerTitle: offer?.title ?? '', offerTitleGu: offer?.titleGu ?? '', discountPaise: offer?.discountPaise ?? 0, gift: offer?.gift ?? null, id, number: `SUB-${++counter}`, customerId, paymentId, status: 'active', cancelledAt: null, cancelReason: '', createdAt: stores.now().toISOString(), idempotencyKey,
      lines: lines.map(line => ({ ...line, id: randomUUID() })),
    })
    if (offer) stores.offers?.redemptions.push({ offerId: offer.id, customerId, checkoutKey: `sub:${id}`, orderId: null, subscriptionId: id, discountPaise: offer.discountPaise })
    act(id, 'started', { paymentMethod: draft.paymentMethod, totalPaise: draft.totalPaise })
    return id
  }

  const repository: SubscriptionRepository = {
    async productPlans(productId) {
      const product = stores.products.rows.find(row => row.id === productId)
      if (!product) return null
      return {
        productId, status: product.status, purchaseMethods: [...product.purchaseMethods], deliveryMethod: product.deliveryMethod, excludedFromCredit: product.excludedFromCredit,
        rules: stores.rules.rows.filter(rule => product.subscriptionRuleIds.includes(rule.id) && rule.status === 'active').map(rule => ({ id: rule.id, name: rule.name, systemType: rule.systemType, lengthOptions: [...rule.lengthOptions], minDays: rule.minDays, maxDays: rule.maxDays })),
        trialPlans: stores.trialPlans.rows.filter(plan => product.trialPlanIds.includes(plan.id) && plan.status === 'active').map(plan => ({ id: plan.id, name: plan.name, durationDays: plan.durationDays })),
      }
    },
    async hasTrial(customerId, productId) { return subscriptions.some(item => item.customerId === customerId && item.productId === productId && item.kind === 'trial' && item.status === 'active') },
    async findIdByIdempotencyKey(customerId, key) { return subscriptions.find(item => item.customerId === customerId && item.idempotencyKey === key)?.id ?? null },
    async create(draft) { return insert(draft, null) },
    async find(id) { const row = subscriptions.find(item => item.id === id); return row ? recordOf(row) : null },
    async listForCustomer(customerId) {
      return subscriptions.filter(item => item.customerId === customerId).sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt.localeCompare(a.createdAt)).map(recordOf)
    },
    async listActive(afterId, limit) {
      return subscriptions.filter(item => item.status === 'active' && (afterId === null || item.id > afterId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map(recordOf)
    },
    async addSkip(subscriptionId, lineId, date, reason) {
      const row = activeRow(subscriptionId)
      if (!row.lines.some(line => line.id === lineId) || stores.orders.skips.some(skip => skip.lineId === lineId && skip.date === date)) return false
      stores.orders.skips.push({ subscriptionId, lineId, date, reason, createdAt: stores.now().toISOString() })
      act(subscriptionId, 'skipped', { date, lineId, reason })
      return true
    },
    async removeSkip(subscriptionId, lineId, date) {
      activeRow(subscriptionId)
      const index = stores.orders.skips.findIndex(skip => skip.subscriptionId === subscriptionId && skip.lineId === lineId && skip.date === date && (skip.reason === 'customer' || skip.reason === 'admin'))
      if (index < 0) return false
      stores.orders.skips.splice(index, 1)
      act(subscriptionId, 'skip_undone', { date, lineId })
      return true
    },
    async clearSkips(subscriptionId, days) {
      for (let index = stores.orders.skips.length - 1; index >= 0; index -= 1) {
        const skip = stores.orders.skips[index]
        if (skip && skip.subscriptionId === subscriptionId && ['customer', 'admin', 'order_cancelled'].includes(skip.reason) && days.some(day => day.lineId === skip.lineId && day.date === skip.date)) stores.orders.skips.splice(index, 1)
      }
    },
    async addPause(subscriptionId, pause, adminId) {
      activeRow(subscriptionId)
      if (overlapsPause(pauses.filter(item => item.subscriptionId === subscriptionId), pause)) throw new AppError(409, 'PAUSE_OVERLAPS', 'These dates overlap a pause already set. Change or resume that one first.')
      pauses.push({ id: randomUUID(), subscriptionId, fromDate: pause.fromDate, untilDate: pause.untilDate })
      act(subscriptionId, 'paused', { fromDate: pause.fromDate, untilDate: pause.untilDate }, adminId)
    },
    async resume(subscriptionId, fromDate) {
      activeRow(subscriptionId)
      const pause = pauses.filter(item => item.subscriptionId === subscriptionId && (item.untilDate === null || item.untilDate >= fromDate)).sort((a, b) => a.fromDate.localeCompare(b.fromDate))[0]
      if (!pause) return false
      if (pause.fromDate >= fromDate) pauses.splice(pauses.indexOf(pause), 1)
      else pause.untilDate = new Date(Date.parse(`${fromDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
      act(subscriptionId, 'resumed', { fromDate })
      return true
    },
    async createDelivery({ subscriptionId, lineId, date, order }, now) {
      const row = subscriptions.find(item => item.id === subscriptionId)
      if (!row || row.status !== 'active') return 'inactive'
      if (stores.orders.skips.some(skip => skip.lineId === lineId && skip.date === date)) return 'skipped'
      if (pauses.some(pause => pause.subscriptionId === subscriptionId && pause.fromDate <= date && (pause.untilDate === null || pause.untilDate >= date))) return 'paused'
      const existing = stores.orders.orders.filter(item => item.subscriptionLineId === lineId && item.deliveryDate === date)
      if (existing.some(item => item.status !== 'cancelled')) return 'exists'
      // The free gift goes out with the first delivery still going to happen: if that one was skipped or cancelled, the next carries it.
      let toWrite = order
      const gift = row.gift
      if (gift && !stores.orders.orders.some(item => item.subscriptionId === subscriptionId && item.status !== 'cancelled' && item.items.some(line => line.isGift))) {
        toWrite = { ...order, items: [...order.items, { productId: gift.productId, variantId: gift.variantId, productName: gift.productName, productNameGu: gift.productNameGu, variantName: gift.variantName, unitPricePaise: 0, quantity: gift.quantity, lineTotalPaise: 0, isGift: true, includeInProductionPlanning: gift.includeInProductionPlanning, productionUnit: gift.productionUnit, productionQuantity: gift.productionQuantity, purchaseMethod: order.items[0]?.purchaseMethod ?? 'subscription' }] }
      }
      try {
        stores.orders.insertOrders(row.customerId, [{ ...toWrite, idempotencyKey: `sub:${lineId}:${date}:${existing.length}` }], now, row.paymentMethod === 'online' ? row.paymentId : null)
        return 'created'
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        if (error.code === 'CUSTOMER_NOT_ACTIVE') return 'customer_inactive'
        stores.orders.skips.push({ subscriptionId, lineId, date, reason: 'credit_limit', createdAt: now.toISOString() })
        act(subscriptionId, 'credit_limit_skipped', { date, lineId, code: error.code })
        return 'credit_limit'
      }
    },
    async ensureGiftCarrier(subscriptionId) {
      const row = subscriptions.find(item => item.id === subscriptionId && item.status === 'active')
      const gift = row?.gift
      if (!row || !gift) return
      const mine = stores.orders.orders.filter(item => item.subscriptionId === subscriptionId)
      if (mine.some(item => item.status !== 'cancelled' && item.items.some(line => line.isGift))) return
      const next = mine.filter(item => item.status === 'placed').sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.orderNumber.localeCompare(b.orderNumber))[0]
      if (!next) return
      next.items.push({ id: randomUUID(), productId: gift.productId, variantId: gift.variantId, productName: gift.productName, productNameGu: gift.productNameGu, variantName: gift.variantName, purchaseMethod: row.kind, unitPricePaise: 0, quantity: gift.quantity, lineTotalPaise: 0, isGift: true })
    },
    async complete(subscriptionId) {
      const row = subscriptions.find(item => item.id === subscriptionId && item.status === 'active')
      if (!row) return
      row.status = 'completed'
      act(subscriptionId, 'completed')
    },
    async markCancelled(subscriptionId, reason, now) {
      const row = subscriptions.find(item => item.id === subscriptionId)
      if (!row || row.status !== 'active') return false
      row.status = 'cancelled'; row.cancelledAt = now.toISOString(); row.cancelReason = reason
      act(subscriptionId, 'cancelled', { reason })
      return true
    },
    async recordCancelRefund(subscriptionId, amountPaise, adminId) {
      const row = subscriptions.find(item => item.id === subscriptionId)
      if (!row || amountPaise <= 0) return
      const dedupeKey = `subscription-cancel:${subscriptionId}`
      if (!stores.orders.adjustments.some(item => item.dedupeKey === dedupeKey)) {
        stores.orders.adjustments.push({ id: randomUUID(), customerId: row.customerId, orderId: null, paymentId: row.paymentId, type: 'refund_pending', status: 'pending', amountPaise, reason: `Subscription ${row.number} cancelled with deliveries unused.`, dedupeKey, createdAt: stores.now().toISOString() })
      }
      act(subscriptionId, 'refund_due', { amountPaise }, adminId)
    },
    async addActivity(subscriptionId, kind, detail = {}, adminId = null) { act(subscriptionId, kind, detail, adminId) },
    async activity(subscriptionId): Promise<SubscriptionActivity[]> {
      return activity.filter(item => item.subscriptionId === subscriptionId).map(item => ({ kind: item.kind, detail: item.detail, createdAt: item.createdAt, byStaff: item.adminId !== null }))
    },
    async adminList({ search, kind, status, page, pageSize }, today) {
      const term = search.toLowerCase()
      const pausedToday = (id: string) => pauses.some(pause => pause.subscriptionId === id && pause.fromDate <= today && (pause.untilDate === null || pause.untilDate >= today))
      const stateOf = (record: { id: string; status: SubscriptionStatus }): SubscriptionStatus | 'paused' => (record.status === 'active' && pausedToday(record.id) ? 'paused' : record.status)
      const anyState = subscriptions.map(recordOf).filter(record => (!kind || record.kind === kind)
        && (!term || `${record.number} ${record.customerName} ${record.customerPhone} ${record.productName} ${record.address.pinCode}`.toLowerCase().includes(term)))
      const counts = { active: 0, paused: 0, completed: 0, cancelled: 0 }
      for (const record of anyState) counts[stateOf(record)] += 1
      const matches = anyState.filter(record => !status || stateOf(record) === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const alertSkips = stores.orders.skips.filter(skip => skip.reason === 'credit_limit' || skip.reason === 'not_deliverable')
      return {
        total: matches.length,
        counts,
        rows: matches.slice((page - 1) * pageSize, page * pageSize).map(({ pauses: _pauses, skips, deliveries, ...record }) => {
          const next = deliveries.filter(item => (item.status === 'placed' || item.status === 'out_for_delivery') && item.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0]
          return {
            ...record, paused: pausedToday(record.id), usedDeliveries: deliveries.filter(item => item.status !== 'cancelled').length, deliveredDeliveries: deliveries.filter(item => item.status === 'delivered').length,
            alerts: skips.filter(skip => skip.reason === 'credit_limit' || skip.reason === 'not_deliverable').length,
            nextDelivery: next ? { date: next.date, slotName: record.lines.find(line => line.id === next.lineId)?.slotName ?? '' } : null,
          }
        }),
        alerts: alertSkips.slice(-20).reverse().map(skip => {
          const row = subscriptions.find(item => item.id === skip.subscriptionId)
          return {
            subscriptionId: skip.subscriptionId, subscriptionNumber: row?.number ?? '', customerName: row ? stores.customers.get(row.customerId)?.name ?? '' : '', date: skip.date,
            slotName: row?.lines.find(line => line.id === skip.lineId)?.slotName ?? '', reason: skip.reason, createdAt: skip.createdAt,
          }
        }),
      }
    },
  }
  return { repository, insert, subscriptions, pauses, activity }
}
