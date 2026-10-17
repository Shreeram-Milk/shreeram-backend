import { z } from 'zod'

const MAX_MONEY_PAISE = 100_000_00_00 // Rs 10 crore: far above any real amount, low enough to catch a typo with extra zeros.
const money = z.number().int('Use whole paise.').min(1, 'Enter an amount above zero.').max(MAX_MONEY_PAISE, 'That amount is too large.')
const note = z.string().trim().max(300, 'Keep the note under 300 characters.').default('')

export const customerIdParamsSchema = z.object({ customerId: z.uuid('That is not a valid customer id.') })
export const requestParamsSchema = z.object({ customerId: z.uuid('That is not a valid customer id.'), requestId: z.uuid('That is not a valid request id.') })
export const customerRequestParamsSchema = z.object({ id: z.uuid('That is not a valid request id.') })

export const creditAccountListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  /** Only customers who owe something. */
  owingOnly: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type CreditAccountListQuery = z.infer<typeof creditAccountListQuerySchema>

export const ledgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
})
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>

export const creditLimitSchema = z.object({ limitPaise: z.number().int('Use whole paise.').min(0, 'The limit cannot be negative.').max(MAX_MONEY_PAISE, 'That limit is too large.') })
export type CreditLimitInput = z.infer<typeof creditLimitSchema>

export const PAYMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'other'] as const
/** Money a credit customer handed over (cash, UPI, bank transfer) that staff record. */
export const recordPaymentSchema = z.object({
  amountPaise: money,
  method: z.enum(PAYMENT_METHODS),
  note,
  /** If this settles a payment request the customer was sent, the request is closed with it. */
  paymentRequestId: z.uuid().optional(),
})
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>

/** A correction to the ledger. The old entries are never changed; a mistake is fixed by adding the opposite entry. */
export const adjustmentSchema = z.object({
  direction: z.enum(['debit', 'credit']),
  amountPaise: money,
  description: z.string().trim().min(3, 'Say why, in a few words.').max(300, 'Keep the reason under 300 characters.'),
})
export type AdjustmentInput = z.infer<typeof adjustmentSchema>

export const paymentRequestSchema = z.object({ amountPaise: money, note })
export type PaymentRequestInput = z.infer<typeof paymentRequestSchema>
