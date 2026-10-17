import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-15.')

export const MAX_LINES = 6
export const MAX_QUANTITY_PER_SLOT = 20

const lineSchema = z.object({
  slotId: z.uuid('That is not a valid delivery window.'),
  quantity: z.number().int('Quantity must be a whole number.').min(1, 'At least 1.').max(MAX_QUANTITY_PER_SLOT, `At most ${MAX_QUANTITY_PER_SLOT} per delivery.`),
})

/**
 * What the phone sends to price or start a subscription or a trial. Only choices and ids: the price, the dates and how it is
 * paid are decided by the server.
 */
export const subscriptionDraftSchema = z.object({
  kind: z.enum(['subscription', 'trial']),
  variantId: z.uuid('That is not a valid product size.'),
  /** A subscription: the product's subscription rule and one of its length options (number of deliveries). */
  ruleId: z.uuid().optional(),
  deliveries: z.number().int().min(1).max(365).optional(),
  /** A subscription: or, instead of a number, the last day the customer picked on the calendar. The server counts the deliveries. */
  endDate: isoDate.optional(),
  /** A trial: one of the product's trial plans (its number of days, delivered daily). */
  trialPlanId: z.uuid().optional(),
  /** "Chosen weekdays" rules: 1 = Monday ... 7 = Sunday. Ignored for other rules. */
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  startDate: isoDate,
  lines: z.array(lineSchema).min(1, 'Choose at least one delivery window.').max(MAX_LINES),
  addressId: z.uuid('Choose a delivery address.'),
  /** A code the customer typed. Without one, the best automatic offer (if any) applies. */
  offerCode: z.string().trim().max(40).optional(),
}).superRefine((value, context) => {
  if (value.kind === 'subscription' && (!value.ruleId || (!value.deliveries && !value.endDate))) context.addIssue({ code: 'custom', path: ['ruleId'], message: 'Choose a schedule and a length.' })
  if (value.kind === 'subscription' && value.deliveries && value.endDate) context.addIssue({ code: 'custom', path: ['endDate'], message: 'Choose a number of deliveries or a last day, not both.' })
  if (value.kind === 'trial' && !value.trialPlanId) context.addIssue({ code: 'custom', path: ['trialPlanId'], message: 'Choose a trial pack.' })
  const slots = value.lines.map(line => line.slotId)
  if (new Set(slots).size !== slots.length) context.addIssue({ code: 'custom', path: ['lines'], message: 'Each delivery window can be chosen once.' })
})
export type SubscriptionDraftInput = z.infer<typeof subscriptionDraftSchema>

export const createSubscriptionSchema = subscriptionDraftSchema.and(z.object({
  /** A fresh value for each press of "Subscribe". A repeat returns the same subscription (or payment). */
  idempotencyKey: z.string().trim().min(8, 'Missing request key.').max(80, 'Request key is too long.'),
  /** The total the customer was shown. If prices changed since, it is refused (PRICE_CHANGED). */
  expectedTotalPaise: z.number().int().min(0).optional(),
}))
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>

export const subscriptionIdParamsSchema = z.object({ id: z.uuid('That is not a valid subscription id.') })

/** Skip (or un-skip) one day: one slot line, or every line of that day when `lineId` is left out. */
export const skipSchema = z.object({ date: isoDate, lineId: z.uuid().optional() })
export type SkipInput = z.infer<typeof skipSchema>

/** A pause from a date; with an end date it is a vacation, without one it lasts until resumed. */
export const pauseSchema = z.object({ fromDate: isoDate, untilDate: isoDate.nullable().default(null) }).refine(value => value.untilDate === null || value.untilDate >= value.fromDate, { path: ['untilDate'], message: 'The end date must be on or after the start date.' })
export type PauseInput = z.infer<typeof pauseSchema>

export const resumeSchema = z.object({ fromDate: isoDate })
export type ResumeInput = z.infer<typeof resumeSchema>

export const cancelSubscriptionSchema = z.object({ reason: z.string().trim().max(300).default('') })
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>

/** The customer's deliveries in a date range, for the calendar and Home. At most about two months at a time. */
export const deliveriesQuerySchema = z.object({ from: isoDate, to: isoDate }).refine(value => value.to >= value.from, { path: ['to'], message: 'The end must be on or after the start.' })
export type DeliveriesQuery = z.infer<typeof deliveriesQuerySchema>

export const adminSubscriptionListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  kind: z.enum(['subscription', 'trial']).optional(),
  status: z.enum(['active', 'paused', 'completed', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type AdminSubscriptionListQuery = z.infer<typeof adminSubscriptionListQuerySchema>
