import { describe, expect, it } from 'vitest'
import { deliveriesUpTo, isoWeekday, onSchedule, overlapsPause, planLine, subscriptionTotalPaise, unusedValuePaise } from '../src/modules/subscriptions/rules.js'

const daily = { type: 'daily' as const, weekdays: [], startDate: '2026-10-11' }
const none = new Set<string>()

describe('subscription schedule', () => {
  it('knows the weekday of a date (Monday 1 ... Sunday 7)', () => {
    expect([isoWeekday('2026-10-12'), isoWeekday('2026-10-18')]).toEqual([1, 7])
  })

  it('delivers daily, every other day from the start, or on the chosen weekdays', () => {
    expect(onSchedule('2026-10-10', daily)).toBe(false)
    const alternate = { type: 'alternate_days' as const, weekdays: [], startDate: '2026-10-11' }
    expect(['2026-10-11', '2026-10-12', '2026-10-13'].map(date => onSchedule(date, alternate))).toEqual([true, false, true])
    const weekdays = { type: 'custom_weekdays' as const, weekdays: [1, 3], startDate: '2026-10-11' }
    expect(planLine({ schedule: weekdays, count: 3, skipped: none, pauses: [] }).dates).toEqual(['2026-10-12', '2026-10-14', '2026-10-19'])
  })

  it('moves the end date later for every skipped or paused day, so every delivery bought still happens', () => {
    expect(planLine({ schedule: daily, count: 3, skipped: none, pauses: [] })).toEqual({ dates: ['2026-10-11', '2026-10-12', '2026-10-13'], complete: true, heldByOpenPause: false })
    expect(planLine({ schedule: daily, count: 3, skipped: new Set(['2026-10-12']), pauses: [] }).dates).toEqual(['2026-10-11', '2026-10-13', '2026-10-14'])
    expect(planLine({ schedule: daily, count: 3, skipped: none, pauses: [{ fromDate: '2026-10-12', untilDate: '2026-10-13' }] }).dates).toEqual(['2026-10-11', '2026-10-14', '2026-10-15'])
  })

  it('holds the remaining deliveries while a pause has no end date', () => {
    expect(planLine({ schedule: daily, count: 3, skipped: none, pauses: [{ fromDate: '2026-10-12', untilDate: null }] })).toEqual({ dates: ['2026-10-11'], complete: false, heldByOpenPause: true })
  })

  it('refuses a pause that overlaps another one', () => {
    const pauses = [{ fromDate: '2026-10-12', untilDate: '2026-10-14' }]
    expect(overlapsPause(pauses, { fromDate: '2026-10-14', untilDate: '2026-10-20' })).toBe(true)
    expect(overlapsPause(pauses, { fromDate: '2026-10-15', untilDate: null })).toBe(false)
    expect(overlapsPause([{ fromDate: '2026-10-20', untilDate: null }], { fromDate: '2026-10-01', untilDate: null })).toBe(true)
  })
})

describe('counting deliveries up to a last day picked on a calendar', () => {
  it('counts every day for daily, every other day from the start, and only chosen weekdays', () => {
    expect(deliveriesUpTo(daily, '2026-10-15')).toEqual({ count: 5, lastDate: '2026-10-15' })
    const alternate = { type: 'alternate_days' as const, weekdays: [], startDate: '2026-10-11' }
    expect(deliveriesUpTo(alternate, '2026-10-16')).toEqual({ count: 3, lastDate: '2026-10-15' })
    const weekdays = { type: 'custom_weekdays' as const, weekdays: [1, 3], startDate: '2026-10-11' }
    expect(deliveriesUpTo(weekdays, '2026-10-21')).toEqual({ count: 4, lastDate: '2026-10-21' })
  })
  it('counts nothing when the last day is before the first', () => {
    expect(deliveriesUpTo(daily, '2026-10-10')).toEqual({ count: 0, lastDate: null })
  })
  it('agrees with planLine: the same number of deliveries ends on the same day', () => {
    const plan = planLine({ schedule: daily, count: 12, skipped: new Set(), pauses: [] })
    expect(deliveriesUpTo(daily, plan.dates.at(-1) as string).count).toBe(12)
  })
})

describe('subscription money (whole paise)', () => {
  it('charges every delivery of every slot at the frozen price', () => {
    expect(subscriptionTotalPaise(3500, 30, [1, 2])).toBe(315_000)
  })

  it('values only the deliveries not yet used, for the refund to send on cancelling', () => {
    expect(unusedValuePaise(3500, 30, [{ quantity: 1, used: 10 }, { quantity: 2, used: 30 }, { quantity: 1, used: 31 }])).toBe(70_000)
  })
})
