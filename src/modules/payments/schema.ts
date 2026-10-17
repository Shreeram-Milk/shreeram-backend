import { z } from 'zod'

/** Our id for a payment at PhonePe: "SRM" and 32 hex characters (PhonePe allows letters, digits, _ and -, up to 63). */
export const MERCHANT_ORDER_ID = /^SRM[0-9a-f]{32}$/

export const merchantOrderParamsSchema = z.object({ merchantOrderId: z.string().regex(MERCHANT_ORDER_ID, 'That is not a valid payment reference.') })
export const paymentIdParamsSchema = z.object({ id: z.uuid('That is not a valid payment id.') })

/** A press of "Pay now". The same key again (a network retry) returns the same payment instead of starting a second one. */
export const startRequestPaymentSchema = z.object({ idempotencyKey: z.string().trim().min(8, 'Missing request key.').max(80, 'Request key is too long.') })
export type StartRequestPayment = z.infer<typeof startRequestPaymentSchema>

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded', 'partially_refunded'] as const
export const adminPaymentListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  status: z.enum(PAYMENT_STATUSES).optional(),
  purpose: z.enum(['order', 'credit_settlement', 'subscription']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>

/** PhonePe's webhook, read leniently (PhonePe adds fields without notice): only what is needed to find the payment. */
export const webhookSchema = z.object({
  event: z.string().max(100).default(''),
  payload: z.object({
    merchantOrderId: z.string().max(100).default(''),
    orderId: z.string().max(100).default(''),
    state: z.string().max(40).default(''),
  }).loose().default({ merchantOrderId: '', orderId: '', state: '' }),
}).loose()
export type PhonePeWebhook = z.infer<typeof webhookSchema>
