import { z } from 'zod'

export const ADJUSTMENT_TYPES = ['carry_forward', 'account_credit', 'refund_pending', 'manual_adjustment'] as const
export const ADJUSTMENT_STATUSES = ['pending', 'applied', 'cancelled'] as const

export const adjustmentIdParamsSchema = z.object({ id: z.uuid('That is not a valid adjustment id.') })

export const adjustmentListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  status: z.enum(ADJUSTMENT_STATUSES).optional(),
  type: z.enum(ADJUSTMENT_TYPES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type AdjustmentListQuery = z.infer<typeof adjustmentListQuerySchema>

/** A correction staff add by hand for a prepaid customer. Carry-forwards come from skipped or cancelled deliveries, never typed in. */
export const newAdjustmentSchema = z.object({
  customerId: z.uuid('Choose a customer.'),
  type: z.enum(['account_credit', 'refund_pending', 'manual_adjustment']),
  amountPaise: z.number().int('Use whole paise.').min(1, 'Enter an amount above zero.').max(100_000_00_00, 'That amount is too large.'),
  reason: z.string().trim().min(3, 'Say why, in a few words.').max(300, 'Keep the reason under 300 characters.'),
})
export type NewAdjustment = z.infer<typeof newAdjustmentSchema>

/** Marking an adjustment done. For a refund, the reference is the one PhonePe showed when the admin sent the refund there. */
export const applyAdjustmentSchema = z.object({
  providerReference: z.string().trim().max(100, 'Keep the reference under 100 characters.').default(''),
  note: z.string().trim().max(300).default(''),
})
export type ApplyAdjustment = z.infer<typeof applyAdjustmentSchema>
