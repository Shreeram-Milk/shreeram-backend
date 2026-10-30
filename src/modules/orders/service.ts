import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import type { PaymentService, PaymentStart } from '../payments/service.js'
import type { CustomerAddress, CustomerAddressRepository } from '../customer-addresses/repository.js'
import type { DeliveryBrainService, SlotOffer } from '../delivery-brain/service.js'
import { indiaClock } from '../delivery-brain/rules.js'
import { noopNotifier, type Notifier } from '../notifications/notifier.js'
import { formatDay, formatDayGujarati } from '../notifications/rules.js'
import type { DeliveryMethod } from '../products/schema.js'
import type { OfferService } from '../offers/service.js'
import { distributeDiscount } from '../offers/rules.js'
import type { Actor, AdminOrderView, NewOrder, OrderRepository, OrderView } from './repository.js'
import { creditEligible, customerCanCancel, doorstepNoteOf, groupBySetup, lineTotalPaise, mergeLines, subtotalPaise, withinCreditLimit, type CartLine, type CheckoutVariant, type OrderGroup } from './rules.js'
import type { AdminOrderListQuery, BulkStatus, CheckoutInput, CourierInput, CustomerOrderListQuery, OrderStatusChange, QuoteInput, ReturnMoney } from './schema.js'

type Dependencies = {
  repository: OrderRepository
  addresses: Pick<CustomerAddressRepository, 'find' | 'getInstructions'>
  delivery: Pick<DeliveryBrainService, 'check'>
  audit: AuditWriter
  /** Orders paid online are written only after this confirms the payment (payment first, order after). */
  payments?: Pick<PaymentService, 'start'>
  /** Chooses the offer (if any) a cart gets. Without it, orders carry no discount. */
  offers?: Pick<OfferService, 'evaluate'>
  /** Tells the customer when staff move an order along or skip one of their plan days. Never blocks or fails the change itself. */
  notifier?: Notifier
  now?: () => Date
}

export type QuoteItem = { variantId: string; productId: string; productName: string; productNameGu: string; variantName: string; unitPricePaise: number; quantity: number; lineTotalPaise: number
  /** A free gift from the offer: priced at nothing, delivered with the order that earned it. */
  isGift?: boolean }
/** One order the cart will become, as the checkout review shows it. */
export type QuoteOrder = {
  key: string; deliveryMethod: DeliveryMethod; items: QuoteItem[]; subtotalPaise: number; discountPaise: number; totalPaise: number
  /** The delivery windows the address gets for this order (own delivery only), each with its first date and order-by time. */
  slots: SlotOffer[]; selectedSlotId: string | null; deliveryDate: string | null; orderBy: string | null
  payment: 'credit' | 'online'
  /** Why it is not on credit, for a credit customer: one of its products is not available on credit. */
  paymentNote: 'excluded_product' | null
}
export type QuoteProblem = { code: string; message: string; details?: unknown }
/** A cart item that cannot be delivered to the chosen PIN. It is left out of the orders and the total, and stays in the cart. */
export type UnavailableItem = { variantId: string; productId: string; productName: string; productNameGu: string; variantName: string; quantity: number }
export type Quote = {
  pinCode: string; orders: QuoteOrder[]; unavailable: UnavailableItem[]; totalPaise: number
  /** The offer this cart got, with the money it takes off (already taken off the totals). */
  offer: { id: string; title: string; titleGu: string; code: string | null; discountPaise: number } | null
  credit: { limitPaise: number; owedPaise: number; remainingPaise: number; neededPaise: number } | null
  problems: QuoteProblem[]
}

type Analysed = { quote: Quote; groups: OrderGroup[]; address: CustomerAddress; chosen: Map<string, SlotOffer | null>
  /** The free gift to add to each order (by order key), with what is needed to write it. */
  gifts: Map<string, { variant: CheckoutVariant; quantity: number }> }

const notFoundOrder = () => new AppError(404, 'ORDER_NOT_FOUND', 'That order does not exist.')

export function createOrderService({ repository, addresses, delivery, audit, payments, offers, notifier = noopNotifier, now = () => new Date() }: Dependencies) {
  /**
   * After staff change an order's status: out for delivery and delivered tell the customer; a plan day cancelled by staff tells them it
   * was skipped (it is added at the end), and a one-time order cancelled by staff tells them it was cancelled. The same order and status is announced only once, however many times the button is pressed.
   */
  async function announce(orderId: string, status: string): Promise<void> {
    if (status !== 'out_for_delivery' && status !== 'delivered' && status !== 'cancelled') return
    try {
      const order = await repository.adminFind(orderId)
      if (!order) return
      const product = order.items[0]?.productName ?? ''
      const productGujarati = order.items[0]?.productNameGu ?? ''
      if (status === 'cancelled') {
        if (!order.subscriptionId) {
          await notifier.notify({
            event: 'order_cancelled', customerId: order.customerId, vars: { order: order.orderNumber, product }, varsGujarati: { product: productGujarati },
            link: `/order-tracking?orderId=${orderId}`, dedupeKey: `order:${orderId}:cancelled`,
          })
          return
        }
        await notifier.notify({
          event: 'day_skipped', customerId: order.customerId, vars: { product, date: formatDay(order.deliveryDate), window: order.slot?.name ?? '' },
          varsGujarati: { product: productGujarati, date: formatDayGujarati(order.deliveryDate) },
          link: `/subscription-manage?id=${order.subscriptionId}`, dedupeKey: `order:${orderId}:cancelled`,
        })
        return
      }
      await notifier.notify({ event: status, customerId: order.customerId, vars: { order: order.orderNumber, product }, varsGujarati: { product: productGujarati }, link: `/order-tracking?orderId=${orderId}`, dedupeKey: `order:${orderId}:${status}` })
    } catch {
      // The status change already succeeded; failing to tell the customer must not undo or hide it.
    }
  }

  /** Tells the customer their order is placed. Once per order, however many times it runs, and never fails the caller. */
  async function announcePlaced(customerId: string, placed: OrderView[]): Promise<void> {
    for (const order of placed) {
      try {
        await notifier.notify({
          event: 'order_placed', customerId, vars: { order: order.orderNumber, product: order.items[0]?.productName ?? '' }, varsGujarati: { product: order.items[0]?.productNameGu ?? '' },
          link: `/order-tracking?orderId=${order.id}`, dedupeKey: `order:${order.id}:placed`,
        })
      } catch {
        // The order is already placed; failing to tell the customer must not hide it.
      }
    }
  }

  /**
   * Prices the cart and works out what it becomes, entirely from stored data: every size must be live, every product must be
   * deliverable to the address, and each delivery setup becomes its own order. Hard problems (an item that is gone, a PIN that is not
   * served) stop here; softer ones (no window chosen yet, credit limit) are listed in `problems` so the review screen can show them.
   */
  async function analyse(customerId: string, input: QuoteInput): Promise<Analysed> {
    const address = await addresses.find(customerId, input.addressId)
    if (!address) throw new AppError(404, 'ADDRESS_NOT_FOUND', 'That address was not found.')
    const requested = mergeLines(input.lines)
    const found = new Map((await repository.loadVariants(requested.map(line => line.variantId))).map(variant => [variant.variantId, variant]))
    const allLines: CartLine[] = requested.map(({ variantId, quantity, slotId }) => {
      const variant = found.get(variantId)
      if (!variant || !variant.variantActive || !variant.productActive || !variant.categoryActive || !variant.deliveryMethod || !variant.serviceAreaId) {
        throw new AppError(409, 'ITEM_UNAVAILABLE', `${variant?.productName ?? 'An item in your cart'} is no longer available. Remove it to continue.`, { variantId })
      }
      if (!variant.purchaseMethods.includes('buy_once')) throw new AppError(409, 'BUY_ONCE_NOT_OFFERED', 'This product cannot be bought as a one-time purchase.')
      if (variant.deliveryMethod === 'shipping' && slotId) throw new AppError(409, 'SLOT_NOT_AVAILABLE', 'Courier products do not use delivery windows.')
      return { variant, quantity, ...(slotId ? { slotId } : {}) }
    })

    // Is each product deliverable to this PIN right now, and which windows does it get? Asked once per product.
    const productIds = [...new Set(allLines.map(line => line.variant.productId))]
    const answers = new Map(await Promise.all(productIds.map(async id => [id, await delivery.check(address.pinCode, id)] as const)))
    // Items this PIN is not served for are set aside, not fatal: the customer can still order the rest. If none is left, the quote has no orders and placing is refused.
    const lines = allLines.filter(line => answers.get(line.variant.productId)?.served)
    const unavailable: UnavailableItem[] = allLines.filter(line => !answers.get(line.variant.productId)?.served).map(line => ({
      variantId: line.variant.variantId, productId: line.variant.productId, productName: line.variant.productName, productNameGu: line.variant.productNameGu, variantName: line.variant.variantName, quantity: line.quantity,
    }))

    const money = await repository.customerMoney(customerId)
    if (!money || money.status !== 'active') throw new AppError(403, 'CUSTOMER_NOT_ACTIVE', 'This account cannot place orders.')
    const problems: QuoteProblem[] = []
    const groups = groupBySetup(lines)
    const chosen = new Map<string, SlotOffer | null>()
    const today = indiaClock(now()).date

    const orders = groups.map((group): QuoteOrder => {
      const answer = answers.get(group.lines[0]?.variant.productId ?? '')
      const slots = group.deliveryMethod === 'local_delivery' && answer?.served ? answer.slots : []
      // The customer's choice must be one of the offered windows. With no choice made and only one window offered, that one is used.
      // An explicit choice on the review screen wins; otherwise the window picked on the product page, if it is still offered.
      const wanted = input.slots[group.key] ?? group.lines[0]?.slotId
      const picked = wanted ? (slots.find(slot => slot.slotId === wanted) ?? null) : (slots.length === 1 ? (slots[0] ?? null) : null)
      chosen.set(group.key, picked)
      if (group.deliveryMethod === 'local_delivery' && !picked) {
        problems.push({ code: wanted ? 'SLOT_NOT_AVAILABLE' : 'SLOT_REQUIRED', message: 'Choose a delivery window for this order.', details: { key: group.key } })
      }
      const subtotal = subtotalPaise(group.lines)
      const onCredit = money.customerType === 'credit' && creditEligible(group.lines)
      return {
        key: group.key, deliveryMethod: group.deliveryMethod, subtotalPaise: subtotal, discountPaise: 0, totalPaise: subtotal,
        items: group.lines.map(line => ({
          variantId: line.variant.variantId, productId: line.variant.productId, productName: line.variant.productName, productNameGu: line.variant.productNameGu,
          variantName: line.variant.variantName, unitPricePaise: line.variant.pricePaise, quantity: line.quantity, lineTotalPaise: lineTotalPaise(line),
        })),
        slots, selectedSlotId: picked?.slotId ?? null,
        deliveryDate: group.deliveryMethod === 'shipping' ? today : (picked?.earliestDate ?? null), orderBy: picked?.orderBy ?? null,
        payment: onCredit ? 'credit' : 'online',
        paymentNote: money.customerType === 'credit' && !onCredit ? 'excluded_product' : null,
      }
    })

    // One offer for the whole checkout, worked out by the server from the stored prices. Its discount is shared across the orders in whole paise.
    let offer: Quote['offer'] = null
    const gifts = new Map<string, { variant: CheckoutVariant; quantity: number }>()
    if (offers && orders.length > 0) {
      const evaluation = await offers.evaluate({
        customerId, purchase: 'one_time', code: input.offerCode,
        lines: orders.flatMap(order => order.items.map(item => ({ productId: item.productId, variantId: item.variantId, quantity: item.quantity, totalPaise: item.lineTotalPaise }))),
      })
      if (evaluation.problem) problems.push({ code: evaluation.problem.code, message: evaluation.problem.message, details: evaluation.problem.details })
      if (evaluation.applied?.gift) {
        // The gift travels with the order that holds a product that earned it, whatever its own delivery setup.
        const gift = evaluation.applied.gift
        const target = orders.find(order => order.items.some(item => gift.triggerProductIds.includes(item.productId)))
        const [giftVariant] = await repository.loadVariants([gift.variantId])
        if (target && giftVariant && giftVariant.variantActive && giftVariant.productActive && giftVariant.categoryActive) {
          target.items.push({ variantId: giftVariant.variantId, productId: giftVariant.productId, productName: giftVariant.productName, productNameGu: giftVariant.productNameGu, variantName: giftVariant.variantName, unitPricePaise: 0, quantity: gift.quantity, lineTotalPaise: 0, isGift: true })
          gifts.set(target.key, { variant: giftVariant, quantity: gift.quantity })
          offer = { id: evaluation.applied.offerId, title: evaluation.applied.title, titleGu: evaluation.applied.titleGu, code: evaluation.applied.code, discountPaise: 0 }
        } else if (input.offerCode) {
          problems.push({ code: 'OFFER_NOT_FOR_THIS', message: 'That offer does not apply to what is in your cart.' })
        }
      }
      if (evaluation.applied && !evaluation.applied.gift) {
        // An offer never makes the checkout free: at least Rs 1 stays to pay, so there is always a real payment or credit charge.
        const discountPaise = Math.min(evaluation.applied.discountPaise, Math.max(0, orders.reduce((sum, order) => sum + order.subtotalPaise, 0) - 100))
        offer = { id: evaluation.applied.offerId, title: evaluation.applied.title, titleGu: evaluation.applied.titleGu, code: evaluation.applied.code, discountPaise }
        const shares = distributeDiscount(discountPaise, orders.map(order => order.subtotalPaise))
        orders.forEach((order, index) => { order.discountPaise = shares[index] ?? 0; order.totalPaise = order.subtotalPaise - order.discountPaise })
      }
    }

    const creditNeeded = orders.filter(order => order.payment === 'credit').reduce((sum, order) => sum + order.totalPaise, 0)
    const credit = money.customerType === 'credit'
      ? { limitPaise: money.creditLimitPaise, owedPaise: money.owedPaise, remainingPaise: Math.max(0, money.creditLimitPaise - money.owedPaise), neededPaise: creditNeeded }
      : null
    if (credit && creditNeeded > 0 && !withinCreditLimit(credit.limitPaise, credit.owedPaise, creditNeeded)) {
      problems.push({ code: 'CREDIT_LIMIT_EXCEEDED', message: 'This order is above your credit limit.', details: credit })
    }
    if (orders.some(order => order.payment === 'online') && !payments) {
      problems.push({ code: 'ONLINE_PAYMENT_UNAVAILABLE', message: 'Online payment is not available yet.' })
    }
    return { quote: { pinCode: address.pinCode, orders, unavailable, offer, totalPaise: orders.reduce((sum, order) => sum + order.totalPaise, 0), credit, problems }, groups, address, chosen, gifts }
  }

  /** Does a database error say "that unique value already exists"? A repeated press of Place order lands here. */
  const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'

  /**
   * Turns a checked cart into the exact orders to write, priced and dated now. Refuses a total the customer did not see
   * (PRICE_CHANGED), a cart with nothing deliverable, and any open problem (no window chosen, credit limit).
   */
  async function prepare(customerId: string, input: CheckoutInput, keyPrefix: string): Promise<{ orders: NewOrder[]; onlinePaise: number }> {
    const { quote, groups, address, chosen, gifts } = await analyse(customerId, input)
    // The customer must pay the price they saw. If anything changed since the review, they are told and see the new price first.
    if (input.expectedTotalPaise !== undefined && input.expectedTotalPaise !== quote.totalPaise) {
      throw new AppError(409, 'PRICE_CHANGED', 'The price changed. Please review your order again.', { totalPaise: quote.totalPaise })
    }
    if (quote.orders.length === 0) throw new AppError(409, 'NOT_DELIVERABLE', `Nothing in your cart can be delivered to ${address.pinCode}.`, { pinCode: address.pinCode })
    const problem = quote.problems[0]
    if (problem) throw new AppError(409, problem.code, problem.message, problem.details)
    const doorstepNote = doorstepNoteOf(await addresses.getInstructions(customerId))

    const orders = groups.map((group, index): NewOrder => {
      const planned = quote.orders[index]
      if (!planned) throw new Error('Quote and groups disagree.')
      const slot = chosen.get(group.key) ?? null
      return {
        idempotencyKey: `${keyPrefix}${index}`, deliveryMethod: group.deliveryMethod, serviceAreaId: group.serviceAreaId,
        deliveryDate: planned.deliveryDate ?? indiaClock(now()).date, slot: slot ? { id: slot.slotId, name: slot.name, startTime: slot.startTime, endTime: slot.endTime } : null, orderBy: slot?.orderBy ?? null, cancelBy: slot?.cancelBy ?? null,
        recipientName: address.recipientName, recipientPhone: address.recipientPhone, addressLine1: address.line1, addressLine2: address.line2, landmark: address.landmark, city: address.city, pinCode: address.pinCode, doorstepNote,
        items: group.lines.map(line => ({
          productId: line.variant.productId, variantId: line.variant.variantId, productName: line.variant.productName, productNameGu: line.variant.productNameGu, variantName: line.variant.variantName,
          unitPricePaise: line.variant.pricePaise, quantity: line.quantity, lineTotalPaise: lineTotalPaise(line),
          includeInProductionPlanning: line.variant.includeInProductionPlanning, productionUnit: line.variant.productionUnit, productionQuantity: line.variant.productionQuantity,
        })).concat((() => {
          const gift = gifts.get(group.key)
          return gift ? [{
            productId: gift.variant.productId, variantId: gift.variant.variantId, productName: gift.variant.productName, productNameGu: gift.variant.productNameGu, variantName: gift.variant.variantName,
            unitPricePaise: 0, quantity: gift.quantity, lineTotalPaise: 0, isGift: true,
            includeInProductionPlanning: gift.variant.includeInProductionPlanning, productionUnit: gift.variant.productionUnit, productionQuantity: gift.variant.productionQuantity,
          }] : []
        })()),
        subtotalPaise: planned.subtotalPaise, totalPaise: planned.totalPaise, discountPaise: planned.discountPaise,
        ...(quote.offer ? { offer: { id: quote.offer.id, title: quote.offer.title, titleGu: quote.offer.titleGu, checkoutKey: keyPrefix } } : {}),
        payment: planned.payment === 'online' ? { method: 'online' } : { method: 'credit' },
      }
    })
    const onlinePaise = orders.filter(order => order.payment.method === 'online').reduce((sum, order) => sum + order.totalPaise, 0)
    return { orders, onlinePaise }
  }

  /**
   * How long PhonePe should accept the payment: until the earliest order-by time in the checkout, between 5 and 15 minutes.
   * A frozen order can therefore be paid at most a few minutes after its cut-off, never hours later.
   */
  function payWindowSeconds(orders: NewOrder[]): number {
    const deadlines = orders.map(order => (order.orderBy ? Date.parse(order.orderBy) : Number.NaN)).filter(Number.isFinite)
    const untilCutoff = deadlines.length > 0 ? (Math.min(...deadlines) - now().getTime()) / 1000 : 900
    return Math.min(900, Math.max(300, untilCutoff))
  }

  return {
    async quote(customerId: string, input: QuoteInput): Promise<Quote> { return (await analyse(customerId, input)).quote },

    /**
     * Places a checkout that needs no online payment (credit, or nothing to pay). The same request key twice returns the same
     * orders and never charges anything twice. A checkout with anything paid online must go through `startPayment`.
     */
    async place(customerId: string, input: CheckoutInput): Promise<{ orders: OrderView[] }> {
      const prefix = `${input.idempotencyKey}:`
      const earlier = await repository.findByKeyPrefix(customerId, prefix)
      if (earlier.length > 0) return { orders: earlier }
      const { orders, onlinePaise } = await prepare(customerId, input, prefix)
      if (onlinePaise > 0) throw new AppError(409, 'PAYMENT_REQUIRED', 'This order is paid online.', { amountPaise: onlinePaise })
      try {
        const placed = await repository.placeOrders(customerId, orders, now())
        await announcePlaced(customerId, placed)
        return { orders: placed }
      } catch (error) {
        // Two identical requests at the same moment: the second one finds the first one's orders instead of failing.
        if (isUniqueViolation(error)) {
          const existing = await repository.findByKeyPrefix(customerId, prefix)
          if (existing.length > 0) return { orders: existing }
        }
        throw error
      }
    },

    /**
     * Starts paying online for a checkout. The orders are priced, dated and frozen now; they are written exactly as frozen once
     * PhonePe confirms the payment. Credit orders in the same checkout are written at that moment too, so a checkout is never
     * half-placed. The same request key returns the same payment.
     */
    async startPayment(customerId: string, input: CheckoutInput): Promise<PaymentStart> {
      if (!payments) throw new AppError(503, 'ONLINE_PAYMENT_UNAVAILABLE', 'Online payment is not available yet.')
      const orderKeyPrefix = `online:${input.idempotencyKey}:`
      return payments.start({
        customerId, purpose: 'order', idempotencyKey: input.idempotencyKey,
        plan: async () => {
          const { orders, onlinePaise } = await prepare(customerId, input, orderKeyPrefix)
          if (onlinePaise === 0) throw new AppError(409, 'NO_PAYMENT_NEEDED', 'Nothing in this order is paid online.')
          return { amountPaise: onlinePaise, snapshot: { kind: 'order', version: 1, orderKeyPrefix, orders }, paymentRequestId: null, expireAfterSeconds: payWindowSeconds(orders) }
        },
      })
    },

    announcePlaced,

    listMine: (customerId: string, query: CustomerOrderListQuery) => repository.listForCustomer(customerId, query),

    async getMine(customerId: string, orderId: string): Promise<OrderView & { canCancel: boolean }> {
      const order = await repository.findForCustomer(customerId, orderId)
      if (!order) throw notFoundOrder()
      return { ...order, canCancel: customerCanCancel(order, now()) }
    },

    async cancelMine(customerId: string, orderId: string, reason: string): Promise<OrderView> {
      // Whether cancelling is still allowed is checked again inside the same locked step that changes the status, so it cannot race with staff.
      const cancelled = await repository.changeStatus(orderId, 'cancelled', { actor: { customer: true }, note: '', reason, ownedBy: customerId }, now())
      if (!cancelled) throw notFoundOrder()
      return cancelled
    },

    adminList: (query: AdminOrderListQuery) => repository.adminList(query),

    async adminGet(orderId: string): Promise<AdminOrderView> {
      const order = await repository.adminFind(orderId)
      if (!order) throw notFoundOrder()
      return order
    },

    /** Staff return the money for a missed or delivered order (their decision, once). */
    async adminReturnMoney(orderId: string, input: ReturnMoney, actor: { adminId: string; ip: string | null }): Promise<AdminOrderView> {
      const updated = await repository.returnMoney(orderId, { adminId: actor.adminId, reason: input.reason }, now())
      if (!updated) throw notFoundOrder()
      await audit({ adminId: actor.adminId, action: 'order_money_returned', details: { orderId, reason: input.reason }, ip: actor.ip })
      const full = await repository.adminFind(orderId)
      if (!full) throw notFoundOrder()
      return full
    },

    async adminSetCourier(orderId: string, input: CourierInput, actor: { adminId: string; ip: string | null }): Promise<AdminOrderView> {
      const updated = await repository.setCourier(orderId, input)
      if (!updated) throw notFoundOrder()
      await audit({ adminId: actor.adminId, action: 'order_courier_set', details: { orderId, courierName: input.courierName }, ip: actor.ip })
      const full = await repository.adminFind(orderId)
      if (!full) throw notFoundOrder()
      return full
    },

    /**
     * One status step for many orders. Each order is changed on its own (an order that cannot take the step is reported and
     * skipped, never half-changed), so one odd order does not stop the rest.
     */
    async adminBulkStatus(input: BulkStatus, actor: { adminId: string; ip: string | null }): Promise<{ updated: number; failed: Array<{ orderId: string; code: string }> }> {
      const failed: Array<{ orderId: string; code: string }> = []
      let updated = 0
      for (const orderId of [...new Set(input.orderIds)]) {
        try {
          const changed = await repository.changeStatus(orderId, input.status, { actor: { adminId: actor.adminId }, note: input.note, reason: '' }, now())
          if (changed) { updated += 1; await announce(orderId, input.status) }
          else failed.push({ orderId, code: 'ORDER_NOT_FOUND' })
        } catch (error) {
          if (!(error instanceof AppError)) throw error
          failed.push({ orderId, code: error.code })
        }
      }
      await audit({ adminId: actor.adminId, action: 'orders_bulk_status', details: { status: input.status, updated, failed: failed.length }, ip: actor.ip })
      return { updated, failed }
    },

    async adminSetStatus(orderId: string, change: OrderStatusChange, actor: { adminId: string; ip: string | null }): Promise<AdminOrderView> {
      const asActor: Actor = { adminId: actor.adminId }
      const updated = await repository.changeStatus(orderId, change.status, { actor: asActor, note: change.note, reason: change.status === 'cancelled' ? change.note : '' }, now())
      if (!updated) throw notFoundOrder()
      await audit({ adminId: actor.adminId, action: 'order_status_changed', details: { orderId, status: change.status }, ip: actor.ip })
      await announce(orderId, change.status)
      const full = await repository.adminFind(orderId)
      if (!full) throw notFoundOrder()
      return full
    },
  }
}

export type OrderService = ReturnType<typeof createOrderService>
