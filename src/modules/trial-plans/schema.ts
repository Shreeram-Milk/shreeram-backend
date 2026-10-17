import { z } from 'zod'
import { RECORD_STATUSES, descriptionField, nameField } from '../master-data/shared.js'

export const trialPlanInputSchema = z.object({
  name: nameField,
  description: descriptionField,
  durationDays: z.number().int('Use a whole number of days.').min(1, 'A trial lasts at least 1 day.').max(365, 'A trial can last at most 365 days.'),
  status: z.enum(RECORD_STATUSES).default('active'),
})

export type TrialPlanInput = z.infer<typeof trialPlanInputSchema>
