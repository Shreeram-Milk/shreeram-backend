import { z } from 'zod'
import { RECORD_STATUSES, descriptionField, nameField } from '../master-data/shared.js'

export const SUBSCRIPTION_TYPES = ['daily', 'alternate_days', 'custom_weekdays'] as const

export const subscriptionRuleInputSchema = z.object({
  name: nameField,
  description: descriptionField,
  systemType: z.enum(SUBSCRIPTION_TYPES),
  /** The lengths a customer may choose, in deliveries per window (for example 15 and 30). Sorted, no repeats. */
  lengthOptions: z.array(z.number().int('Use whole numbers of deliveries.').min(1, 'At least 1 delivery.').max(365, 'At most 365 deliveries.'))
    .min(1, 'Add at least one length.').max(6, 'At most 6 lengths.').default([15, 30])
    .transform(values => [...new Set(values)].sort((a, b) => a - b)),
  /** How many days a plan must run at least, and at most, counted from the first to the last delivery day (both included). */
  minDays: z.number().int('Use a whole number of days.').min(1, 'At least 1 day.').max(365, 'At most 365 days.').default(5),
  maxDays: z.number().int('Use a whole number of days.').min(1, 'At least 1 day.').max(730, 'At most 730 days.').default(180),
  status: z.enum(RECORD_STATUSES).default('active'),
}).refine(rule => rule.maxDays >= rule.minDays, { path: ['maxDays'], message: 'The longest plan cannot be shorter than the shortest.' })

export type SubscriptionRuleInput = z.infer<typeof subscriptionRuleInputSchema>
export type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number]
