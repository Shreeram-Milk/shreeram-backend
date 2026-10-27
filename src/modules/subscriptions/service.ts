import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import type { CustomerAddressRepository } from '../customer-addresses/repository.js'
import { addDays, cancelMoment, indiaClock, orderByMoment } from '../delivery-brain/rules.js'
import type { DeliveryBrainService, SlotRule, SlotRules } from '../delivery-brain/service.js'
import { doorstepNoteOf } from '../orders/rules.js'
import type { NewOrder, OrderRepository, OrderView } from '../orders/repository.js'
import { noopNotifier, type Notifier } from '../notifications/notifier.js'
import { formatDay, formatDayGujarati } from '../notifications/rules.js'
import type { PaymentService, PaymentStart } from '../payments/service.js'
import type { OfferService } from '../offers/service.js'
import type { ProductPlans, SkipReason, StoredPause, SubscriptionActivity, SubscriptionDraft, SubscriptionGift, SubscriptionRecord, SubscriptionRepository } from './repository.js'
import { daysBetween, deliveriesUpTo, deliveryDiscountShares, onSchedule, openPause, planLine, subscriptionTotalPaise, unusedPaidPaise, type Pause, type ScheduleType } from './rules.js'
import type { AdminSubscriptionListQuery, CancelSubscriptionInput, CreateSubscriptionInput, DeliveriesQuery, PauseInput, ResumeInput, SkipInput, SubscriptionDraftInput } from './schema.js'

type Logger = { warn(data: object, message: string): void; error(data: object, message: string): void }
type Dependencies = {
  repository: SubscriptionRepository
  orders: Pick<OrderRepository, 'loadVariants' | 'customerMoney' | 'changeStatus' | 'deliveriesBetween'>
  addresses: Pick<CustomerAddressRepository, 'find' | 'getInstructions'>
  delivery: Pick<DeliveryBrainService, 'slotRules'>
  payments?: Pick<PaymentService, 'start'>
  /** Chooses the offer (if any) a plan gets. Without it, plans carry no discount or gift. */
  offers?: Pick<OfferService, 'evaluate'>
  audit: AuditWriter
  logger?: Logger
  /** Tells the customer when staff skip one of their days, or a day is skipped because their credit limit is used up. */
  notifier?: Notifier
  now?: () => Date
}
type Actor = { customerId: string } | { adminId: string; ip: string | null }

/** Orders are made this many days ahead (plus today), so production planning sees subscription demand early. */
export const HORIZON_DAYS = 3
/** The furthest ahead a subscription may start. */
const MAX_START_AHEAD_DAYS = 60
/** How many days of the schedule the customer's subscription screen shows. */
const SHOWN_DAYS = 21
/** Staff see further ahead, on the subscription's Coming days page. */
const ADMIN_SHOWN_DAYS = 62
const MAX_RANGE_DAYS = 62
const BATCH = 100

/** `paused`: a delivery day inside a pause or vacation (it moves to the end; resume to bring it back). */
export type DayLineState = 'upcoming' | 'placed' | 'out_for_delivery' | 'delivered' | 'missed' | 'skipped' | 'paused'
export type DayLine = {
  lineId: string; slotId: string; slotName: string; startTime: string; endTime: string; quantity: number
  state: DayLineState; skipReason: SkipReason | null; orderId: string | null; orderNumber: string | null
  /** Before this day's lock time: the customer can still skip it (or undo a skip they made). */
  canChange: boolean
  /** Until when this day can still be skipped or brought back (its cancel deadline); null when the window is no longer offered there. */
  changeUntil: string | null
}
export type ScheduleDay = { date: string; lines: DayLine[] }
export type ViewLine = { id: string; slotId: string; slotName: string; startTime: string; endTime: string; quantity: number; delivered: number; used: number; remaining: number; endDate: string | null }
export type SubscriptionView = {
  id: string; number: string; kind: 'subscription' | 'trial'; status: 'active' | 'paused' | 'completed' | 'cancelled'
  productId: string; variantId: string; productName: string; productNameGu: string; variantName: string; unitPricePaise: number
  planName: string; scheduleType: ScheduleType; weekdays: number[]; deliveriesPerLine: number; startDate: string; endDate: string | null
  address: SubscriptionRecord['address']; paymentMethod: 'credit' | 'online'; totalPaise: number
  /** The offer it started with: its name ('' when none), the money it took off, and the free gift sent with the first delivery. */
  offerTitle: string; offerTitleGu: string; discountPaise: number
  gift: { productName: string; productNameGu: string; variantName: string; quantity: number } | null
  cancelledAt: string | null; cancelReason: string; createdAt: string
  lines: ViewLine[]; pauses: StoredPause[]; openPause: Pause | null
  nextDelivery: { date: string; slotName: string; quantity: number } | null
  days: ScheduleDay[]
}
export type AdminSubscriptionView = SubscriptionView & {
  customerId: string; customerName: string; customerPhone: string; paymentId: string | null
  activity: SubscriptionActivity[]; deliveries: SubscriptionRecord['deliveries']; skips: SubscriptionRecord['skips']
}
export type SubscriptionQuote = {
  kind: 'subscription' | 'trial'; productName: string; productNameGu: string; variantName: string; unitPricePaise: number
  planName: string; scheduleType: ScheduleType; weekdays: number[]; deliveriesPerLine: number; startDate: string; earliestStartDate: string; endDate: string
  lines: Array<{ slotId: string; slotName: string; startTime: string; endTime: string; quantity: number; linePaise: number; endDate: string }>
  /** The price before any offer, the money the offer takes off, and what is paid (`totalPaise`). */
  subtotalPaise: number; discountPaise: number; totalPaise: number; paymentMethod: 'credit' | 'online'
  /** The offer this plan gets, and any free gift sent with the first delivery. */
  offer: { title: string; titleGu: string; code: string | null; discountPaise: number; gift: { productName: string; productNameGu: string; variantName: string; quantity: number } | null } | null
  /** Why a typed code does not work (the plan can still be bought without it). */
  offerProblem: { code: string; message: string } | null
  /** For a credit customer: why it is paid online (the product is not available on credit). */
  paymentNote: 'excluded_product' | null
  /** For a credit customer: the credit limit, what they owe and what is left. The whole subscription must fit in what is left. */
  credit: { limitPaise: number; owedPaise: number; remainingPaise: number } | null
}
export type DeliveryEntry = {
  date: string; source: 'order' | 'subscription'; state: DayLineState | 'cancelled'
  slotName: string | null; startTime: string | null; endTime: string | null
  items: Array<{ productName: string; productNameGu: string; variantName: string; quantity: number }>
  orderId: string | null; orderNumber: string | null; subscriptionId: string | null; subscriptionNumber: string | null; lineId: string | null; canChange: boolean
}
export type SubscriptionStart = { subscription: SubscriptionView | null; payment: PaymentStart['payment'] | null; checkout: PaymentStart['checkout'] }

const silentLogger: Logger = { warn() {}, error() {} }
const notFound = () => new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'That subscription was not found.')
const scheduleOf = (record: Pick<SubscriptionRecord, 'scheduleType' | 'weekdays' | 'startDate'>) => ({ type: record.scheduleType, weekdays: record.weekdays, startDate: record.startDate })

/**
 * Subscriptions and trials. A trial is a short daily subscription. The rule throughout: the customer chooses, the server
 * decides prices, dates and what is allowed. Every delivery becomes an ordinary order a few days ahead (see `generate`), so
 * production planning, the Orders page, tracking and the status buttons need nothing special for subscriptions.
 */
export function createSubscriptionService({ repository, orders, addresses, delivery, payments, offers, audit, logger = silentLogger, notifier = noopNotifier, now = () => new Date() }: Dependencies) {
  const today = () => indiaClock(now()).date

  /** The plan of every line, worked out from the rule, the skips and the pauses. */
  function plansOf(record: SubscriptionRecord) {
    return new Map(record.lines.map(line => [line.id, planLine({
      schedule: scheduleOf(record), count: record.deliveriesPerLine, pauses: record.pauses,
      skipped: new Set(record.skips.filter(skip => skip.lineId === line.id).map(skip => skip.date)),
    })]))
  }

  const slotOf = (rules: SlotRules, slotId: string): SlotRule | undefined => (rules.served ? rules.slots.find(slot => slot.slotId === slotId) : undefined)
  const changeUntil = (rules: SlotRules, slotId: string, date: string): string | null => {
    const slot = slotOf(rules, slotId)
    return slot ? cancelMoment(date, slot.condition).toISOString() : null
  }
  /** Has the day's cancel deadline passed? A slot the address no longer has is treated as locked: nothing can be changed there. */
  const locked = (rules: SlotRules, line: { slotId: string; startTime: string; endTime: string }, date: string): boolean => {
    const slot = slotOf(rules, line.slotId)
    if (!slot) return date <= today()
    return now().getTime() >= cancelMoment(date, slot.condition).getTime()
  }

  function viewOf(record: SubscriptionRecord, rules: SlotRules, shownDays = SHOWN_DAYS): SubscriptionView {
    const plans = plansOf(record)
    const day = today()
    const lastShown = addDays(day, shownDays - 1)
    const liveOrders = record.deliveries.filter(item => item.status !== 'cancelled')
    const pausedToday = record.pauses.some(pause => pause.fromDate <= day && (pause.untilDate === null || pause.untilDate >= day))
    const status = record.status === 'active' && pausedToday ? 'paused' : record.status

    const lines: ViewLine[] = record.lines.map(line => {
      const used = liveOrders.filter(item => item.lineId === line.id).length
      const plan = plans.get(line.id)
      return {
        id: line.id, slotId: line.slotId, slotName: line.slotName, startTime: line.startTime, endTime: line.endTime, quantity: line.quantity,
        delivered: liveOrders.filter(item => item.lineId === line.id && item.status === 'delivered').length, used, remaining: Math.max(0, record.deliveriesPerLine - used),
        endDate: plan?.complete ? (plan.dates[plan.dates.length - 1] ?? null) : null,
      }
    })

    // The days to show: every planned date and every skip from today on (within the window), in date order.
    const days = new Map<string, DayLine[]>()
    const add = (date: string, entry: DayLine) => { if (date >= day && date <= lastShown) days.set(date, [...(days.get(date) ?? []), entry]) }
    if (record.status === 'active') {
      for (const line of record.lines) {
        const base = { lineId: line.id, slotId: line.slotId, slotName: line.slotName, startTime: line.startTime, endTime: line.endTime, quantity: line.quantity }
        for (const date of plans.get(line.id)?.dates ?? []) {
          const order = liveOrders.find(item => item.lineId === line.id && item.date === date)
          const state: DayLineState = order ? (order.status as Exclude<typeof order.status, 'cancelled'>) : 'upcoming'
          add(date, { ...base, state, skipReason: null, orderId: order?.orderId ?? null, orderNumber: order?.orderNumber ?? null, canChange: (state === 'upcoming' || state === 'placed') && !locked(rules, line, date), changeUntil: changeUntil(rules, line.slotId, date) })
        }
        for (const skip of record.skips.filter(item => item.lineId === line.id)) {
          add(skip.date, { ...base, state: 'skipped', skipReason: skip.reason, orderId: null, orderNumber: null, canChange: (skip.reason === 'customer' || skip.reason === 'admin') && !locked(rules, line, skip.date), changeUntil: changeUntil(rules, line.slotId, skip.date) })
        }
        // Days the customer would have had inside a pause or vacation, so they see what is paused (and do not pause it twice).
        const plan = plans.get(line.id)
        const last = plan?.dates.at(-1)
        for (const pause of record.pauses) {
          const end = pause.untilDate && pause.untilDate < lastShown ? pause.untilDate : lastShown
          for (let date = pause.fromDate > day ? pause.fromDate : day; date <= end; date = addDays(date, 1)) {
            if (!onSchedule(date, scheduleOf(record)) || record.skips.some(skip => skip.lineId === line.id && skip.date === date)) continue
            // A pause after the last delivery changes nothing, so it is not shown.
            if (plan?.complete && (!last || date > last)) continue
            add(date, { ...base, state: 'paused', skipReason: null, orderId: null, orderNumber: null, canChange: false, changeUntil: null })
          }
        }
      }
    }
    const ordered = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, entries]) => ({ date, lines: entries.sort((a, b) => a.startTime.localeCompare(b.startTime)) }))
    const next = ordered.flatMap(entry => entry.lines.filter(line => line.state === 'upcoming' || line.state === 'placed' || line.state === 'out_for_delivery').map(line => ({ date: entry.date, slotName: line.slotName, quantity: line.quantity })))[0] ?? null
    const ends = lines.map(line => line.endDate)
    return {
      id: record.id, number: record.number, kind: record.kind, status, productId: record.productId, variantId: record.variantId, productName: record.productName, productNameGu: record.productNameGu,
      variantName: record.variantName, unitPricePaise: record.unitPricePaise, planName: record.planName, scheduleType: record.scheduleType, weekdays: record.weekdays,
      deliveriesPerLine: record.deliveriesPerLine, startDate: record.startDate, endDate: ends.every(Boolean) ? (ends.sort().at(-1) ?? null) : null,
      address: record.address, paymentMethod: record.paymentMethod, totalPaise: record.totalPaise,
      offerTitle: record.offerTitle, offerTitleGu: record.offerTitleGu, discountPaise: record.discountPaise,
      gift: record.gift ? { productName: record.gift.productName, productNameGu: record.gift.productNameGu, variantName: record.gift.variantName, quantity: record.gift.quantity } : null,
      cancelledAt: record.cancelledAt, cancelReason: record.cancelReason, createdAt: record.createdAt,
      lines, pauses: record.pauses, openPause: openPause(record.pauses), nextDelivery: next, days: ordered,
    }
  }

  async function ownRecord(customerId: string, id: string): Promise<SubscriptionRecord> {
    const record = await repository.find(id)
    if (!record || record.customerId !== customerId) throw notFound()
    return record
  }
  async function anyRecord(id: string): Promise<SubscriptionRecord> {
    const record = await repository.find(id)
    if (!record) throw notFound()
    return record
  }
  const rulesFor = (record: Pick<SubscriptionRecord, 'address' | 'productId'>) => delivery.slotRules(record.address.pinCode, record.productId)
  async function freshView(id: string): Promise<SubscriptionView> {
    const record = await anyRecord(id)
    return viewOf(record, await rulesFor(record))
  }

  /** Checks a draft against the product, the address and the delivery rules, and prices it. Nothing is written. */
  async function analyse(customerId: string, input: SubscriptionDraftInput): Promise<{ quote: SubscriptionQuote; draft: SubscriptionDraft }> {
    const address = await addresses.find(customerId, input.addressId)
    if (!address) throw new AppError(404, 'ADDRESS_NOT_FOUND', 'That address was not found.')
    const [variant] = await orders.loadVariants([input.variantId])
    if (!variant || !variant.variantActive || !variant.productActive || !variant.categoryActive) throw new AppError(409, 'ITEM_UNAVAILABLE', 'This product is not available right now.')
    const plans: ProductPlans | null = await repository.productPlans(variant.productId)
    if (!plans) throw new AppError(409, 'ITEM_UNAVAILABLE', 'This product is not available right now.')
    if (!plans.purchaseMethods.includes(input.kind)) throw new AppError(409, input.kind === 'trial' ? 'TRIAL_NOT_OFFERED' : 'SUBSCRIPTION_NOT_OFFERED', `This product cannot be bought as a ${input.kind}.`)
    if (variant.deliveryMethod !== 'local_delivery') throw new AppError(409, 'SUBSCRIPTION_NEEDS_OWN_DELIVERY', 'Subscriptions and trials are for products we deliver ourselves.')

    let scheduleType: ScheduleType = 'daily'
    let weekdays: number[] = []
    let deliveriesPerLine: number
    let planName: string
    let ruleId: string | null = null
    let trialPlanId: string | null = null
    if (input.kind === 'subscription') {
      const rule = plans.rules.find(item => item.id === input.ruleId)
      if (!rule) throw new AppError(409, 'RULE_NOT_OFFERED', 'That schedule is not offered for this product.')
      scheduleType = rule.systemType
      weekdays = rule.systemType === 'custom_weekdays' ? [...new Set(input.weekdays)].sort() : []
      if (scheduleType === 'custom_weekdays' && weekdays.length === 0) throw new AppError(400, 'WEEKDAYS_REQUIRED', 'Choose at least one weekday.')
      if (input.endDate) {
        // The customer picked the last day on a calendar: the deliveries are the schedule's days from the start up to that day.
        const counted = deliveriesUpTo({ type: scheduleType, weekdays, startDate: input.startDate }, input.endDate)
        if (counted.count < 1) throw new AppError(409, 'LENGTH_TOO_SHORT', `Choose a last day on or after ${input.startDate}.`, { minDays: rule.minDays })
        deliveriesPerLine = counted.count
      } else {
        if (!input.deliveries || !rule.lengthOptions.includes(input.deliveries)) throw new AppError(409, 'LENGTH_NOT_OFFERED', 'That length is not offered for this schedule.', { lengthOptions: rule.lengthOptions })
        deliveriesPerLine = input.deliveries
      }
      // The plan must run at least `minDays` and at most `maxDays`, from its first to its last delivery day.
      const lastDay = planLine({ schedule: { type: scheduleType, weekdays, startDate: input.startDate }, count: deliveriesPerLine, skipped: new Set(), pauses: [] }).dates.at(-1) ?? input.startDate
      const span = daysBetween(input.startDate, lastDay) + 1
      if (span < rule.minDays) throw new AppError(409, 'LENGTH_TOO_SHORT', `A subscription must run at least ${rule.minDays} days.`, { minDays: rule.minDays, days: span })
      if (span > rule.maxDays) throw new AppError(409, 'LENGTH_TOO_LONG', `A subscription can run at most ${rule.maxDays} days.`, { maxDays: rule.maxDays, days: span })
      planName = rule.name
      ruleId = rule.id
    } else {
      const plan = plans.trialPlans.find(item => item.id === input.trialPlanId)
      if (!plan) throw new AppError(409, 'TRIAL_NOT_OFFERED', 'That trial pack is not offered for this product.')
      if (await repository.hasTrial(customerId, variant.productId)) throw new AppError(409, 'TRIAL_ALREADY_USED', 'You already have a trial of this product running. You can start another once it has ended.')
      deliveriesPerLine = plan.durationDays
      planName = plan.name
      trialPlanId = plan.id
    }

    const rules = await delivery.slotRules(address.pinCode, variant.productId)
    if (!rules.served) throw new AppError(409, 'NOT_DELIVERABLE', `This product cannot be delivered to ${address.pinCode}.`, { pinCode: address.pinCode })
    const chosen = input.lines.map(line => {
      const slot = slotOf(rules, line.slotId)
      if (!slot) throw new AppError(409, 'SLOT_NOT_AVAILABLE', 'That delivery window is not offered at this address.', { slotId: line.slotId })
      return { slot, quantity: line.quantity }
    })
    const earliestStartDate = chosen.map(item => item.slot.earliestDate).sort().at(-1) as string
    if (input.startDate < earliestStartDate) throw new AppError(409, 'START_TOO_EARLY', 'The first delivery can be on that date at the earliest.', { earliestStartDate })
    if (input.startDate > addDays(today(), MAX_START_AHEAD_DAYS)) throw new AppError(409, 'START_TOO_LATE', `Start within the next ${MAX_START_AHEAD_DAYS} days.`)

    const money = await orders.customerMoney(customerId)
    if (!money || money.status !== 'active') throw new AppError(403, 'CUSTOMER_NOT_ACTIVE', 'This account cannot place orders.')
    const onCredit = money.customerType === 'credit' && !plans.excludedFromCredit
    const schedule = { type: scheduleType, weekdays, startDate: input.startDate }
    const lines = chosen.map(({ slot, quantity }) => {
      const plan = planLine({ schedule, count: deliveriesPerLine, skipped: new Set(), pauses: [] })
      return { slotId: slot.slotId, slotName: slot.name, startTime: slot.startTime, endTime: slot.endTime, quantity, linePaise: variant.pricePaise * quantity * deliveriesPerLine, endDate: plan.dates.at(-1) ?? input.startDate }
    }).sort((a, b) => a.startTime.localeCompare(b.startTime))
    const subtotalPaise = subscriptionTotalPaise(variant.pricePaise, deliveriesPerLine, lines.map(line => line.quantity))
    // One offer for the whole plan, chosen by the server. Its discount is spread over the deliveries; its gift goes with the first delivery.
    let discountPaise = 0
    let draftOffer: SubscriptionDraft['offer'] = null
    let offerInfo: SubscriptionQuote['offer'] = null
    let offerProblem: SubscriptionQuote['offerProblem'] = null
    if (offers) {
      const lastDay = lines.map(line => line.endDate).sort().at(-1) ?? input.startDate
      const evaluation = await offers.evaluate({
        customerId, purchase: input.kind, code: input.offerCode, planDays: daysBetween(input.startDate, lastDay) + 1,
        lines: [{ productId: variant.productId, variantId: variant.variantId, quantity: lines.reduce((sum, line) => sum + line.quantity, 0), totalPaise: subtotalPaise }],
      })
      offerProblem = evaluation.problem ? { code: evaluation.problem.code, message: evaluation.problem.message } : null
      const applied = evaluation.applied
      if (applied) {
        let gift: SubscriptionGift | null = null
        if (applied.gift) {
          const [giftVariant] = await orders.loadVariants([applied.gift.variantId])
          if (giftVariant && giftVariant.variantActive && giftVariant.productActive && giftVariant.categoryActive) {
            gift = {
              variantId: giftVariant.variantId, productId: giftVariant.productId, productName: giftVariant.productName, productNameGu: giftVariant.productNameGu, variantName: giftVariant.variantName, quantity: applied.gift.quantity,
              includeInProductionPlanning: giftVariant.includeInProductionPlanning, productionUnit: giftVariant.productionUnit, productionQuantity: giftVariant.productionQuantity,
            }
          }
        }
        if (!applied.gift || gift) {
          // An offer never makes the plan free: at least Rs 1 stays to pay.
          discountPaise = Math.min(applied.discountPaise, Math.max(0, subtotalPaise - 100))
          draftOffer = { id: applied.offerId, title: applied.title, titleGu: applied.titleGu, discountPaise, gift }
          offerInfo = { title: applied.title, titleGu: applied.titleGu, code: applied.code, discountPaise, gift: gift ? { productName: gift.productName, productNameGu: gift.productNameGu, variantName: gift.variantName, quantity: gift.quantity } : null }
        } else if (input.offerCode) {
          offerProblem = { code: 'OFFER_NOT_FOR_THIS', message: 'That offer does not apply to what you chose.' }
        }
      }
    }
    const totalPaise = subtotalPaise - discountPaise
    const quote: SubscriptionQuote = {
      kind: input.kind, productName: variant.productName, productNameGu: variant.productNameGu, variantName: variant.variantName, unitPricePaise: variant.pricePaise,
      planName, scheduleType, weekdays, deliveriesPerLine, startDate: input.startDate, earliestStartDate, endDate: lines.map(line => line.endDate).sort().at(-1) as string,
      lines, subtotalPaise, discountPaise, totalPaise, offer: offerInfo, offerProblem, paymentMethod: onCredit ? 'credit' : 'online', paymentNote: money.customerType === 'credit' && !onCredit ? 'excluded_product' : null,
      credit: onCredit ? { limitPaise: money.creditLimitPaise, owedPaise: money.owedPaise, remainingPaise: Math.max(0, money.creditLimitPaise - money.owedPaise) } : null,
    }
    const draft: SubscriptionDraft = {
      customerId, kind: input.kind, productId: variant.productId, variantId: variant.variantId, productName: variant.productName, productNameGu: variant.productNameGu, variantName: variant.variantName,
      unitPricePaise: variant.pricePaise, includeInProductionPlanning: variant.includeInProductionPlanning, productionUnit: variant.productionUnit, productionQuantity: variant.productionQuantity,
      ruleId, trialPlanId, planName, scheduleType, weekdays, deliveriesPerLine, startDate: input.startDate,
      address: {
        recipientName: address.recipientName, recipientPhone: address.recipientPhone, addressLine1: address.line1, addressLine2: address.line2, landmark: address.landmark, city: address.city, pinCode: address.pinCode,
        doorstepNote: doorstepNoteOf(await addresses.getInstructions(customerId)),
      },
      paymentMethod: quote.paymentMethod, totalPaise, idempotencyKey: null, offer: draftOffer,
      lines: lines.map(({ slotId, slotName, startTime, endTime, quantity }) => ({ slotId, slotName, startTime, endTime, quantity })),
    }
    return { quote, draft }
  }

  /** The order for one delivery: like a checkout order, at the price frozen in the subscription. */
  function deliveryOrder(record: SubscriptionRecord, line: SubscriptionRecord['lines'][number], date: string, slot: SlotRule, serviceAreaId: string, discountPaise: number): Omit<NewOrder, 'idempotencyKey'> {
    const linePaise = record.unitPricePaise * line.quantity
    return {
      deliveryMethod: 'local_delivery', serviceAreaId, deliveryDate: date,
      slot: { id: line.slotId, name: line.slotName, startTime: line.startTime, endTime: line.endTime }, orderBy: orderByMoment(date, slot.condition)?.toISOString() ?? null, cancelBy: cancelMoment(date, slot.condition).toISOString(),
      recipientName: record.address.recipientName, recipientPhone: record.address.recipientPhone, addressLine1: record.address.addressLine1, addressLine2: record.address.addressLine2,
      landmark: record.address.landmark, city: record.address.city, pinCode: record.address.pinCode, doorstepNote: record.address.doorstepNote,
      items: [{
        productId: record.productId, variantId: record.variantId, productName: record.productName, productNameGu: record.productNameGu, variantName: record.variantName,
        unitPricePaise: record.unitPricePaise, quantity: line.quantity, lineTotalPaise: linePaise,
        includeInProductionPlanning: record.includeInProductionPlanning, productionUnit: record.productionUnit, productionQuantity: record.productionQuantity, purchaseMethod: record.kind,
      }],
      subtotalPaise: linePaise, discountPaise, totalPaise: linePaise - discountPaise, payment: record.paymentMethod === 'credit' ? { method: 'credit' } : { method: 'online' },
      ...(record.offerTitle ? { offerLabel: { title: record.offerTitle, titleGu: record.offerTitleGu } } : {}),
      subscription: { id: record.id, lineId: line.id },
    }
  }

  let lastRun: { at: string; startedAt: string; failures: number } | null = null
  type Tally = { created: number; skipped: number; failures: number }
  /**
   * Makes the orders for one subscription's coming deliveries (today and the next few days), skips days that passed without
   * one (the customer then gets that delivery at the end), and marks it completed once every delivery is behind it.
   */
  async function generateOne(record: SubscriptionRecord, tally: Tally): Promise<void> {
    const day = today()
    const horizon = addDays(day, HORIZON_DAYS)
    const plans = plansOf(record)
    const rules = await rulesFor(record)
    const [variant] = await orders.loadVariants([record.variantId])
    const deliverable = Boolean(variant && variant.productActive && variant.deliveryMethod === 'local_delivery' && variant.serviceAreaId)
    // The plan's offer discount is shared out over its deliveries once, so every delivery carries the same share however the days move.
    const shares = record.discountPaise > 0 ? deliveryDiscountShares(record.discountPaise, record.unitPricePaise, record.deliveriesPerLine, record.lines.map(item => item.quantity)) : []
    for (const [lineIndex, line] of record.lines.entries()) {
      for (const [dateIndex, date] of (plans.get(line.id)?.dates ?? []).entries()) {
        if (date > horizon) break
        if (record.deliveries.some(item => item.lineId === line.id && item.date === date && item.status !== 'cancelled')) continue
        const slot = slotOf(rules, line.slotId)
        if (date < day || !deliverable || !slot) {
          // A day that passed without its order, or that can no longer be delivered: it moves to the end, and staff see it.
          if (await repository.addSkip(record.id, line.id, date, 'not_deliverable')) tally.skipped += 1
          continue
        }
        const outcome = await repository.createDelivery({ subscriptionId: record.id, lineId: line.id, date, order: deliveryOrder(record, line, date, slot, String(variant?.serviceAreaId), shares[lineIndex * record.deliveriesPerLine + dateIndex] ?? 0) }, now())
        if (outcome === 'created') tally.created += 1
        if (outcome === 'credit_limit') {
          tally.skipped += 1
          await notifier.notify({
            event: 'credit_limit_reached', customerId: record.customerId, vars: { product: record.productName, date: formatDay(date), window: line.slotName },
            varsGujarati: { product: record.productNameGu, date: formatDayGujarati(date) },
            link: `/subscription-manage?id=${record.id}`, dedupeKey: `credit:${record.id}:${line.id}:${date}`,
          })
        }
      }
    }
    // A free gift whose order was skipped or cancelled moves to the next delivery that is still coming.
    await repository.ensureGiftCarrier(record.id)
    const allDone = record.lines.every(line => {
      const plan = plans.get(line.id)
      const last = plan?.dates.at(-1)
      return Boolean(plan?.complete && last && last < day && plan.dates.every(date => record.deliveries.some(item => item.lineId === line.id && item.date === date && item.status !== 'cancelled')))
    })
    if (allDone) await repository.complete(record.id)
  }

  /** Brings one subscription's orders up to date now (after it starts, or after a skip, un-skip or resume). */
  async function syncOne(id: string): Promise<void> {
    const record = await repository.find(id)
    if (!record || record.status !== 'active') return
    try {
      await generateOne(record, { created: 0, skipped: 0, failures: 0 })
    } catch (error) {
      // The delivery job will try again within minutes; the customer's change itself already stands.
      logger.error({ subscriptionId: id, err: error }, 'Subscription delivery sync failed')
    }
  }

  /** Cancels this subscription's orders on and after `fromDate` (up to `untilDate`) that can still be changed. */
  async function cancelChangeableOrders(record: SubscriptionRecord, fromDate: string, untilDate: string | null, actor: Actor, note: string): Promise<Array<{ lineId: string; date: string }>> {
    const rules = await rulesFor(record)
    const cancelled: Array<{ lineId: string; date: string }> = []
    for (const item of record.deliveries) {
      if (item.status !== 'placed' || item.date < fromDate || (untilDate !== null && item.date > untilDate)) continue
      const line = record.lines.find(entry => entry.id === item.lineId)
      if (!line || locked(rules, line, item.date)) continue
      await orders.changeStatus(item.orderId, 'cancelled', { actor: 'customerId' in actor ? { customer: true } : { adminId: actor.adminId }, note, reason: note, ownedBy: 'customerId' in actor ? actor.customerId : undefined }, now())
      cancelled.push({ lineId: item.lineId, date: item.date })
    }
    return cancelled
  }

  const adminIdOf = (actor: Actor): string | null => ('adminId' in actor ? actor.adminId : null)
  const log = async (actor: Actor, action: string, details: Record<string, unknown>) => {
    if ('adminId' in actor) await audit({ adminId: actor.adminId, action, details, ip: actor.ip })
  }

  async function skip(record: SubscriptionRecord, input: SkipInput, actor: Actor): Promise<void> {
    if (record.status !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
    const targets = input.lineId ? record.lines.filter(line => line.id === input.lineId) : record.lines
    if (targets.length === 0) throw new AppError(404, 'LINE_NOT_FOUND', 'That delivery window is not part of this subscription.')
    const plans = plansOf(record)
    const rules = await rulesFor(record)
    const due = targets.filter(line => plans.get(line.id)?.dates.includes(input.date))
    if (due.length === 0) throw new AppError(409, 'NOT_A_DELIVERY_DAY', 'There is no delivery on that day to skip.')
    if (due.some(line => locked(rules, line, input.date))) throw new AppError(409, 'SKIP_TOO_LATE', 'It is too late to change that delivery.')
    for (const line of due) {
      const order = record.deliveries.find(item => item.lineId === line.id && item.date === input.date && item.status === 'placed')
      // An order already made is cancelled (that records the skip); otherwise the skip is recorded directly.
      if (order) await orders.changeStatus(order.orderId, 'cancelled', { actor: 'customerId' in actor ? { customer: true } : { adminId: actor.adminId }, note: 'Skipped', reason: 'Skipped', ownedBy: 'customerId' in actor ? actor.customerId : undefined }, now())
      else await repository.addSkip(record.id, line.id, input.date, 'customerId' in actor ? 'customer' : 'admin')
    }
    await log(actor, 'subscription_skipped', { subscriptionId: record.id, date: input.date, lineId: input.lineId ?? null })
    // Only a skip by staff is news to the customer: they know about the ones they made themselves.
    if ('adminId' in actor) {
      for (const line of due) {
        await notifier.notify({
          event: 'day_skipped', customerId: record.customerId, vars: { product: record.productName, date: formatDay(input.date), window: line.slotName },
          varsGujarati: { product: record.productNameGu, date: formatDayGujarati(input.date) },
          link: `/subscription-manage?id=${record.id}`, dedupeKey: `skip:${record.id}:${line.id}:${input.date}`,
        })
      }
    }
  }

  async function unskip(record: SubscriptionRecord, input: SkipInput, actor: Actor): Promise<void> {
    const targets = record.skips.filter(item => item.date === input.date && (!input.lineId || item.lineId === input.lineId) && (item.reason === 'customer' || item.reason === 'admin'))
    if (targets.length === 0) throw new AppError(409, 'NOTHING_TO_UNDO', 'That day was not skipped by you.')
    const rules = await rulesFor(record)
    for (const target of targets) {
      const line = record.lines.find(entry => entry.id === target.lineId)
      if (!line || locked(rules, line, input.date)) throw new AppError(409, 'SKIP_TOO_LATE', 'It is too late to change that delivery.')
    }
    for (const target of targets) await repository.removeSkip(record.id, target.lineId, input.date)
    await log(actor, 'subscription_skip_undone', { subscriptionId: record.id, date: input.date })
    await syncOne(record.id)
  }

  /** The first date from which every line can still be changed: today if nothing is locked yet, else a later day. */
  async function firstChangeableDate(record: SubscriptionRecord): Promise<string> {
    const rules = await rulesFor(record)
    let date = today()
    for (let step = 0; step < 7 && record.lines.some(line => locked(rules, line, date)); step += 1) date = addDays(date, 1)
    return date
  }

  async function pause(record: SubscriptionRecord, input: PauseInput, actor: Actor): Promise<void> {
    if (record.status !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
    const earliest = await firstChangeableDate(record)
    if (input.fromDate < earliest) throw new AppError(409, 'PAUSE_TOO_EARLY', 'The pause can start on that date at the earliest.', { earliestDate: earliest })
    await repository.addPause(record.id, { fromDate: input.fromDate, untilDate: input.untilDate }, adminIdOf(actor))
    const cancelled = await cancelChangeableOrders(record, input.fromDate, input.untilDate, actor, 'Paused')
    // Cancelling an order records a skip; the pause already covers those days, so the skips go, or resuming early would leave them skipped.
    await repository.clearSkips(record.id, cancelled)
    await log(actor, 'subscription_paused', { subscriptionId: record.id, fromDate: input.fromDate, untilDate: input.untilDate })
  }

  async function resume(record: SubscriptionRecord, input: ResumeInput, actor: Actor): Promise<void> {
    if (record.status !== 'active') throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
    const earliest = await firstChangeableDate(record)
    if (input.fromDate < earliest) throw new AppError(409, 'RESUME_TOO_EARLY', 'Deliveries can restart on that date at the earliest.', { earliestDate: earliest })
    if (!(await repository.resume(record.id, input.fromDate))) throw new AppError(409, 'NOT_PAUSED', 'This subscription is not paused then.')
    await log(actor, 'subscription_resumed', { subscriptionId: record.id, fromDate: input.fromDate })
    await syncOne(record.id)
  }

  /**
   * Cancels a subscription: no new deliveries, the ones not yet locked are cancelled, and for one paid upfront the unused
   * deliveries become a "refund to send" item for staff to decide on (never an automatic refund).
   */
  async function cancel(record: SubscriptionRecord, input: CancelSubscriptionInput, actor: Actor): Promise<void> {
    if (!(await repository.markCancelled(record.id, input.reason, now()))) throw new AppError(409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.')
    await cancelChangeableOrders(record, today(), null, actor, 'Subscription cancelled')
    const after = await anyRecord(record.id)
    if (after.paymentMethod === 'online') {
      const lines = after.lines.map(line => ({ quantity: line.quantity, used: after.deliveries.filter(item => item.lineId === line.id && item.status !== 'cancelled').length }))
      // Exactly what was paid for the deliveries not made: their value minus the offer discount that was spread over them.
      await repository.recordCancelRefund(after.id, unusedPaidPaise(after.unitPricePaise, after.deliveriesPerLine, lines, after.discountPaise), adminIdOf(actor))
    }
    await log(actor, 'subscription_cancelled', { subscriptionId: record.id })
  }

  async function adminGet(id: string): Promise<AdminSubscriptionView> {
    const record = await anyRecord(id)
    const view = viewOf(record, await rulesFor(record), ADMIN_SHOWN_DAYS)
    return { ...view, customerId: record.customerId, customerName: record.customerName, customerPhone: record.customerPhone, paymentId: record.paymentId, activity: await repository.activity(id), deliveries: record.deliveries, skips: record.skips }
  }

  return {
    async quote(customerId: string, input: SubscriptionDraftInput): Promise<SubscriptionQuote> { return (await analyse(customerId, input)).quote },

    /**
     * Starts a subscription or trial. A credit customer's starts at once (each delivery is charged when its order is made);
     * anyone paying online pays the whole amount first, and the subscription is written only once PhonePe confirms.
     */
    async create(customerId: string, input: CreateSubscriptionInput): Promise<SubscriptionStart> {
      const earlier = await repository.findIdByIdempotencyKey(customerId, input.idempotencyKey)
      if (earlier) return { subscription: await freshView(earlier), payment: null, checkout: null }
      const { quote, draft } = await analyse(customerId, input)
      // A credit subscription is charged delivery by delivery, but it is only worth starting if the whole of it fits in the credit
      // that is left: otherwise it would start and then skip days one by one.
      if (quote.credit && quote.totalPaise > quote.credit.remainingPaise) {
        throw new AppError(409, 'SUBSCRIPTION_ABOVE_CREDIT', 'This subscription is above your credit limit.', { ...quote.credit, neededPaise: quote.totalPaise })
      }
      if (input.offerCode && quote.offerProblem) throw new AppError(409, quote.offerProblem.code, quote.offerProblem.message)
      if (input.expectedTotalPaise !== undefined && input.expectedTotalPaise !== quote.totalPaise) {
        throw new AppError(409, 'PRICE_CHANGED', 'The price changed. Please review again.', { totalPaise: quote.totalPaise })
      }
      if (draft.paymentMethod === 'credit') {
        const id = await repository.create({ ...draft, idempotencyKey: input.idempotencyKey })
        await syncOne(id)
        return { subscription: await freshView(id), payment: null, checkout: null }
      }
      if (!payments) throw new AppError(503, 'ONLINE_PAYMENT_UNAVAILABLE', 'Online payment is not available yet.')
      const started = await payments.start({
        customerId, purpose: 'subscription', idempotencyKey: input.idempotencyKey,
        plan: async () => ({ amountPaise: draft.totalPaise, snapshot: { kind: 'subscription', version: 1, draft: { ...draft, idempotencyKey: input.idempotencyKey } }, paymentRequestId: null, expireAfterSeconds: 900 }),
      })
      return { subscription: null, payment: started.payment, checkout: started.checkout }
    },

    /** Makes a subscription's coming orders now (used right after an online payment starts it). */
    syncNow: (id: string) => syncOne(id),

    async listMine(customerId: string): Promise<SubscriptionView[]> {
      const records = await repository.listForCustomer(customerId)
      return Promise.all(records.map(async record => viewOf(record, await rulesFor(record))))
    },
    async getMine(customerId: string, id: string): Promise<SubscriptionView> {
      const record = await ownRecord(customerId, id)
      return viewOf(record, await rulesFor(record))
    },
    async skipMine(customerId: string, id: string, input: SkipInput) { await skip(await ownRecord(customerId, id), input, { customerId }); return freshView(id) },
    /** A skip made by the customer cannot be undone by the customer. Only staff can bring a day back (adminUnskip). */
    async unskipMine(_customerId: string, _id: string, _input: SkipInput): Promise<never> { throw new AppError(409, 'SKIP_IS_FINAL', 'A skip cannot be undone. The day was added to the end of your plan, so you still get every delivery you bought.') },
    async pauseMine(customerId: string, id: string, input: PauseInput) { await pause(await ownRecord(customerId, id), input, { customerId }); return freshView(id) },
    async resumeMine(customerId: string, id: string, input: ResumeInput) { await resume(await ownRecord(customerId, id), input, { customerId }); return freshView(id) },
    async cancelMine(customerId: string, id: string, input: CancelSubscriptionInput) { await cancel(await ownRecord(customerId, id), input, { customerId }); return freshView(id) },

    /**
     * Everything the customer has coming (or had) between two dates, one-off orders and subscription days together, for the
     * delivery calendar and Home's "next delivery".
     */
    async deliveries(customerId: string, { from, to }: DeliveriesQuery): Promise<DeliveryEntry[]> {
      if (to > addDays(from, MAX_RANGE_DAYS)) throw new AppError(400, 'RANGE_TOO_LONG', `Ask for at most ${MAX_RANGE_DAYS} days at a time.`)
      const [oneOff, records] = await Promise.all([orders.deliveriesBetween(customerId, from, to), repository.listForCustomer(customerId)])
      const entries: DeliveryEntry[] = oneOff.filter((order: OrderView) => order.subscriptionId === null).map(order => ({
        date: order.deliveryDate, source: 'order', state: order.status === 'cancelled' ? 'cancelled' : order.status,
        slotName: order.slot?.name ?? null, startTime: order.slot?.startTime ?? null, endTime: order.slot?.endTime ?? null,
        items: order.items.map(item => ({ productName: item.productName, productNameGu: item.productNameGu, variantName: item.variantName, quantity: item.quantity })),
        orderId: order.id, orderNumber: order.orderNumber, subscriptionId: null, subscriptionNumber: null, lineId: null, canChange: false,
      }))
      for (const record of records.filter(item => item.status === 'active')) {
        const view = viewOf(record, await rulesFor(record))
        for (const dayEntry of view.days.filter(item => item.date >= from && item.date <= to)) {
          for (const line of dayEntry.lines) {
            entries.push({
              date: dayEntry.date, source: 'subscription', state: line.state, slotName: line.slotName, startTime: line.startTime, endTime: line.endTime,
              items: [{ productName: record.productName, productNameGu: record.productNameGu, variantName: record.variantName, quantity: line.quantity }],
              orderId: line.orderId, orderNumber: line.orderNumber, subscriptionId: record.id, subscriptionNumber: record.number, lineId: line.lineId, canChange: line.canChange,
            })
          }
        }
      }
      return entries.sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '99').localeCompare(b.startTime ?? '99'))
    },

    /**
     * The delivery job: for every active subscription, makes the orders for today and the next few days, moves days that
     * could not be delivered to the end, and closes finished subscriptions. Safe to run any number of times, even at once.
     */
    async generate(): Promise<{ checked: number; failures: number; created: number; skipped: number }> {
      const startedAt = now()
      const tally: Tally = { created: 0, skipped: 0, failures: 0 }
      let checked = 0
      let after: string | null = null
      for (;;) {
        const batch = await repository.listActive(after, BATCH)
        for (const record of batch) {
          checked += 1
          try {
            await generateOne(record, tally)
          } catch (error) {
            tally.failures += 1
            logger.error({ subscriptionId: record.id, err: error }, 'Subscription delivery job failed for one subscription')
          }
        }
        if (batch.length < BATCH) break
        after = batch[batch.length - 1]?.id ?? null
      }
      lastRun = { at: now().toISOString(), startedAt: startedAt.toISOString(), failures: tally.failures }
      return { checked, ...tally }
    },

    /** When the delivery job last finished a pass on this server, and how many subscriptions failed in it. Null before the first pass. */
    jobStatus: (): { at: string; failures: number } | null => (lastRun ? { at: lastRun.at, failures: lastRun.failures } : null),

    adminList: (query: AdminSubscriptionListQuery) => repository.adminList(query, today()),
    adminGet,
    async adminSkip(id: string, input: SkipInput, actor: { adminId: string; ip: string | null }) { await skip(await anyRecord(id), input, actor); return adminGet(id) },
    async adminUnskip(id: string, input: SkipInput, actor: { adminId: string; ip: string | null }) { await unskip(await anyRecord(id), input, actor); return adminGet(id) },
    async adminPause(id: string, input: PauseInput, actor: { adminId: string; ip: string | null }) { await pause(await anyRecord(id), input, actor); return adminGet(id) },
    async adminResume(id: string, input: ResumeInput, actor: { adminId: string; ip: string | null }) { await resume(await anyRecord(id), input, actor); return adminGet(id) },
    async adminCancel(id: string, input: CancelSubscriptionInput, actor: { adminId: string; ip: string | null }) { await cancel(await anyRecord(id), input, actor); return adminGet(id) },
  }
}

export type SubscriptionService = ReturnType<typeof createSubscriptionService>
