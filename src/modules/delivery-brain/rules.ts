/**
 * The delivery time rules, as plain functions with no database. Everything is in India time (Asia/Kolkata, UTC+05:30,
 * which has no daylight saving), never the server machine's own timezone.
 */
export type DayRelation = 'same_day' | 'previous_day'
/**
 * A slot's cut-off: orders for a day close at `cutoffTime` (that day or the day before). Customers may cancel or skip until
 * the cancel time when one is set (never later than the cut-off), otherwise until the cut-off itself.
 */
export type CutoffCondition = { dayRelation: DayRelation; cutoffTime: string; cancelDayRelation?: DayRelation | null; cancelTime?: string | null }

const IST_OFFSET_MINUTES = 330
const MINUTE = 60_000

/** "06:30" -> 390 minutes after midnight. */
export const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/** What the clock on the wall in India says for this moment. */
export function indiaClock(instant: Date): { date: string; minutes: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * MINUTE)
  return { date: shifted.toISOString().slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() }
}

/** "2026-10-31" + 1 -> "2026-11-01". Calendar arithmetic only, so month ends and leap days are handled. */
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00.000Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

/** The real moment (UTC) when it is `time` on `date` in India. */
export function instantAt(date: string, time: string): Date {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + (minutesOf(time) - IST_OFFSET_MINUTES) * MINUTE)
}

export type SlotWindow = { startTime: string; endTime: string }

/**
 * The first date a customer can get a delivery in this slot, and the last moment they could have ordered for it.
 *
 * With a cut-off rule: "same day" means the order must be in before the cut-off time on the delivery day itself;
 * "previous day" means before the cut-off time on the day before. An order placed exactly at the cut-off time is late.
 * Without a rule: today if the slot has not started yet, otherwise tomorrow, and there is no order-by time.
 * A slot that has already ended today is never offered for today.
 */
export function earliestDelivery(slot: SlotWindow, condition: CutoffCondition | null, now: Date): { date: string; orderBy: string | null } {
  const clock = indiaClock(now)
  const orderBy = (date: string) => (condition ? instantAt(condition.dayRelation === 'previous_day' ? addDays(date, -1) : date, condition.cutoffTime).toISOString() : null)

  let date = clock.date
  if (condition) {
    const cutoff = minutesOf(condition.cutoffTime)
    const lateToday = clock.minutes >= cutoff
    date = condition.dayRelation === 'previous_day' ? addDays(clock.date, lateToday ? 2 : 1) : addDays(clock.date, lateToday ? 1 : 0)
  } else if (clock.minutes >= minutesOf(slot.startTime)) {
    date = addDays(clock.date, 1)
  }
  if (date === clock.date && clock.minutes >= minutesOf(slot.endTime)) date = addDays(date, 1)
  return { date, orderBy: orderBy(date) }
}

/** The order-by moment of a delivery on `date`: the cut-off time, or null when the slot has no cut-off rule. */
export function orderByMoment(date: string, condition: CutoffCondition | null): Date | null {
  return condition ? instantAt(condition.dayRelation === 'previous_day' ? addDays(date, -1) : date, condition.cutoffTime) : null
}

/**
 * Until when a delivery on `date` can still be cancelled or skipped by the customer: the rule's cancel time when one is
 * set, otherwise its order-by time. A slot with no cut-off rule closes at midnight at the start of the delivery day, the
 * same for one-time orders and subscription days. From this moment on the day is fixed.
 */
export function cancelMoment(date: string, condition: CutoffCondition | null): Date {
  if (condition?.cancelDayRelation && condition.cancelTime) return instantAt(condition.cancelDayRelation === 'previous_day' ? addDays(date, -1) : date, condition.cancelTime)
  return orderByMoment(date, condition) ?? instantAt(date, '00:00')
}
