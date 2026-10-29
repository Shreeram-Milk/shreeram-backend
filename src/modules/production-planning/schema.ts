import { z } from 'zod'

/** The delivery day to plan for, as an India calendar date. */
export const productionPlanQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-15.').refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'That is not a real date.'),
})
export type ProductionPlanQuery = z.infer<typeof productionPlanQuerySchema>

/** The rider sheet: a delivery day and one delivery window of it. */
export const riderSheetQuerySchema = productionPlanQuerySchema.extend({ slotId: z.uuid() })
export type RiderSheetQuery = z.infer<typeof riderSheetQuerySchema>
