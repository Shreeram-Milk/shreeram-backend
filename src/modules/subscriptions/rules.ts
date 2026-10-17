import { distributeDiscount } from '../offers/rules.js'
/**
 * Subscription schedules as plain functions: no database, no clock of their own, India calendar dates ("2026-10-15") only.
 *
 * A subscription promises N deliveries per chosen slot. Its dates are worked out from the rule (daily, every other day, or
 * chosen weekdays) starting at the start date, leaving out paused days and skipped days. So a skip or a pause never loses a
 * delivery: the slot simply runs one delivery longer.
 */
import { addDays } from '../delivery-brain/rules.js'

export type ScheduleType = 'daily' | 'alternate_days' | 'custom_weekdays'
export type Schedule = { type: ScheduleType; weekdays: number[]; startDate: string }
/** No deliveries from `fromDate`; an open pause (`untilDate` null) lasts until the customer resumes. */
export type Pause = { fromDate: string; untilDate: string | null }

/** Looking further than this for N delivery days means something is wrong (an impossible rule); stop rather than loop. */
const MAX_SCAN_DAYS = 4 * 366
const DAY_MS = 86_400_000

/** 1 = Monday ... 7 = Sunday (ISO), for an India calendar date. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  return day === 0 ? 7 : day
}

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS)

/** Is `date` a delivery day of this rule? Every other day counts from the start date. */
export function onSchedule(date: string, schedule: Schedule): boolean {
  if (date < schedule.startDate) return false
  if (schedule.type === 'daily') return true
  if (schedule.type === 'alternate_days') return daysBetween(schedule.startDate, date) % 2 === 0
  return schedule.weekdays.includes(isoWeekday(date))
}

export const pausedOn = (date: string, pauses: readonly Pause[]): boolean => pauses.some(pause => date >= pause.fromDate && (pause.untilDate === null || date <= pause.untilDate))

/** The pause still open (no end date), if any. */
export const openPause = (pauses: readonly Pause[]): Pause | null => pauses.find(pause => pause.untilDate === null) ?? null

export type LinePlan = {
  /** The delivery dates, in order: up to N of them. */
  dates: string[]
  /** All N dates are known. */
  complete: boolean
  /** An open pause stops the schedule: the remaining deliveries wait until the customer resumes. */
  heldByOpenPause: boolean
}

/** The N delivery dates of one slot line, leaving out paused and skipped days. */
export function planLine({ schedule, count, skipped, pauses }: { schedule: Schedule; count: number; skipped: ReadonlySet<string>; pauses: readonly Pause[] }): LinePlan {
  const dates: string[] = []
  let date = schedule.startDate
  for (let scanned = 0; scanned < MAX_SCAN_DAYS && dates.length < count; scanned += 1, date = addDays(date, 1)) {
    if (!onSchedule(date, schedule)) continue
    if (pauses.some(pause => pause.untilDate === null && date >= pause.fromDate)) return { dates, complete: false, heldByOpenPause: true }
    if (pausedOn(date, pauses) || skipped.has(date)) continue
    dates.push(date)
  }
  return { dates, complete: dates.length === count, heldByOpenPause: false }
}

/**
 * How many delivery days a schedule has from its start date up to and including `endDate` (no skips or pauses: those move the
 * end later afterwards), and the last of them. Used to turn the last day a customer picked on a calendar into a number of deliveries.
 */
export function deliveriesUpTo(schedule: Schedule, endDate: string): { count: number; lastDate: string | null } {
  let count = 0
  let lastDate: string | null = null
  if (endDate < schedule.startDate) return { count, lastDate }
  const days = Math.min(daysBetween(schedule.startDate, endDate), MAX_SCAN_DAYS)
  for (let offset = 0; offset <= days; offset += 1) {
    const date = addDays(schedule.startDate, offset)
    if (onSchedule(date, schedule)) { count += 1; lastDate = date }
  }
  return { count, lastDate }
}

/** What the whole subscription costs: every delivery of every line, at the price frozen when subscribing. Whole paise. */
export const subscriptionTotalPaise = (unitPricePaise: number, deliveriesPerLine: number, quantities: readonly number[]): number =>
  quantities.reduce((sum, quantity) => sum + unitPricePaise * quantity * deliveriesPerLine, 0)

/**
 * What an online-paid subscription cancelled midway owes back: the deliveries not yet used, at the frozen price. A delivery is
 * "used" once its order exists and was not cancelled (delivered, missed, on its way, or placed and locked).
 */
export const unusedValuePaise = (unitPricePaise: number, deliveriesPerLine: number, lines: ReadonlyArray<{ quantity: number; used: number }>): number =>
  lines.reduce((sum, line) => sum + unitPricePaise * line.quantity * Math.max(0, deliveriesPerLine - line.used), 0)

/** Pauses must not overlap: a new one may start only after every earlier one has ended. */
export const overlapsPause = (pauses: readonly Pause[], candidate: Pause): boolean =>
  pauses.some(pause => (pause.untilDate === null || candidate.fromDate <= pause.untilDate) && (candidate.untilDate === null || pause.fromDate <= candidate.untilDate))

/**
 * The offer discount of a plan is spread over its deliveries in proportion to what each costs, in whole paise (largest remainder),
 * so every delivery carries the same share however it moves. The share of delivery number `k` of slot line `li` sits at `li * perLine + k`.
 */
export function deliveryDiscountShares(discountPaise: number, unitPricePaise: number, perLine: number, quantities: readonly number[]): number[] {
  return distributeDiscount(discountPaise, quantities.flatMap(quantity => Array.from({ length: perLine }, () => unitPricePaise * quantity)))
}

/** What the customer actually paid for the deliveries not made yet: their value minus the offer discount that was spread over them. */
export function unusedPaidPaise(unitPricePaise: number, perLine: number, lines: ReadonlyArray<{ quantity: number; used: number }>, discountPaise: number): number {
  const shares = deliveryDiscountShares(discountPaise, unitPricePaise, perLine, lines.map(line => line.quantity))
  let unusedDiscount = 0
  lines.forEach((line, lineIndex) => { for (let k = Math.min(perLine, line.used); k < perLine; k += 1) unusedDiscount += shares[lineIndex * perLine + k] ?? 0 })
  return Math.max(0, unusedValuePaise(unitPricePaise, perLine, lines) - unusedDiscount)
}
