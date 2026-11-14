import { z } from 'zod'
import { REFUND_STATUSES, WALLET_MAX_BALANCE_PAISE, WALLET_MIN_TOP_UP_PAISE } from './rules.js'

const idempotencyKey = z.string().trim().min(8, 'Missing request key.').max(80, 'Request key is too long.')

/** Adding money with PhonePe. */
export const topUpSchema = z.object({
  amountPaise: z.number().int()
    .min(WALLET_MIN_TOP_UP_PAISE, `Add at least ₹${WALLET_MIN_TOP_UP_PAISE / 100}.`)
    .max(WALLET_MAX_BALANCE_PAISE, `A wallet can hold up to ₹${WALLET_MAX_BALANCE_PAISE / 100}.`),
  idempotencyKey,
})
export type TopUpInput = z.infer<typeof topUpSchema>

/** Asking for the whole balance back. */
export const refundRequestSchema = z.object({
  note: z.string().trim().max(300, 'Keep it under 300 characters.').default(''),
  idempotencyKey,
})
export type RefundRequestInput = z.infer<typeof refundRequestSchema>

export const walletPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})
export type WalletPageQuery = z.infer<typeof walletPageSchema>

export const adminRefundListSchema = walletPageSchema.extend({ status: z.enum(REFUND_STATUSES).optional() })
export type AdminRefundListQuery = z.infer<typeof adminRefundListSchema>

export const refundIdParamsSchema = z.object({ id: z.uuid('That is not a valid refund request.') })
export const walletCustomerParamsSchema = z.object({ customerId: z.uuid('That is not a valid customer.') })

/**
 * Staff refunded it in PhonePe. One part per PhonePe refund: the top-up payment it was sent against, how much, and the reference
 * PhonePe showed. The parts must add up to the request (the repository checks that, and that no payment is refunded past what it paid).
 */
export const refundPartSchema = z.object({
  paymentId: z.uuid('That is not a valid payment.'),
  amountPaise: z.number().int().min(1, 'Enter an amount.').max(WALLET_MAX_BALANCE_PAISE),
  providerReference: z.string().trim().min(1, 'Enter the PhonePe refund reference.').max(100),
})
export type RefundPartInput = z.infer<typeof refundPartSchema>
export const markRefundSentSchema = z.object({
  parts: z.array(refundPartSchema).min(1, 'Add at least one PhonePe refund.').max(10)
    .refine(parts => new Set(parts.map(part => part.paymentId)).size === parts.length, 'Each payment can appear only once.'),
  note: z.string().trim().max(300).default(''),
})
export type MarkRefundSentInput = z.infer<typeof markRefundSentSchema>

/** Every customer who has ever used the wallet. `show`: everyone, only those with a refund waiting, or only those holding money. */
export const walletCustomerListSchema = walletPageSchema.extend({
  search: z.string().trim().max(80).default(''),
  show: z.enum(['all', 'waiting', 'balance']).default('all'),
})
export type WalletCustomerListQuery = z.infer<typeof walletCustomerListSchema>

/** Staff will not refund it: the money goes back into the wallet. */
export const cancelRefundSchema = z.object({ note: z.string().trim().min(3, 'Say why, in a few words.').max(300) })
export type CancelRefundInput = z.infer<typeof cancelRefundSchema>

/** A staff correction, always with a reason. */
export const walletAdjustmentSchema = z.object({
  direction: z.enum(['credit', 'debit']),
  amountPaise: z.number().int().min(1).max(WALLET_MAX_BALANCE_PAISE),
  reason: z.string().trim().min(3, 'Say why, in a few words.').max(300),
})
export type WalletAdjustmentInput = z.infer<typeof walletAdjustmentSchema>
