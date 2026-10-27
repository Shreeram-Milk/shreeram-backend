import { z } from 'zod'
import { ORDER_STATUSES } from './rules.js'

export const MAX_CART_LINES = 40
export const MAX_QUANTITY_PER_LINE = 100

const lineSchema = z.object({
  variantId: z.uuid('That is not a valid product size.'),
  /** The delivery window the customer picked on the product page. It is only a preference: used when it is offered, ignored when it is not. */
  slotId: z.uuid().optional(),
  quantity: z.number().int('Quantity must be a whole number.').min(1, 'Quantity must be at least 1.').max(MAX_QUANTITY_PER_LINE, `At most ${MAX_QUANTITY_PER_LINE} of one item.`),
})

/**
 * What the phone sends to price or place an order. Only ids and quantities: prices, totals, delivery dates and the payment
 * method are all decided by the server. `slots` says which delivery window the customer chose for each delivery setup.
 */
export const checkoutInputSchema = z.object({
  addressId: z.uuid('Choose a delivery address.'),
  lines: z.array(lineSchema).min(1, 'Your cart is empty.').max(MAX_CART_LINES, `At most ${MAX_CART_LINES} different items in one order.`).superRefine((lines, context) => {
    const quantities = new Map<string, number>()
    for (const [index, line] of lines.entries()) {
      const key = `${line.variantId}:${line.slotId ?? ''}`
      const total = (quantities.get(key) ?? 0) + line.quantity
      quantities.set(key, total)
      if (total > MAX_QUANTITY_PER_LINE) context.addIssue({ code: 'custom', path: [index, 'quantity'], message: `At most ${MAX_QUANTITY_PER_LINE} of one item per delivery window.` })
    }
  }),
  slots: z.record(z.string().max(200), z.uuid('Choose a delivery window.')).default({}),
  /** A fresh value for each press of "Place order". A repeated value returns the same orders instead of making new ones. */
  idempotencyKey: z.string().trim().min(8, 'Missing request key.').max(80, 'Request key is too long.'),
  /** A code the customer typed. Without one, the best automatic offer (if any) applies. */
  offerCode: z.string().trim().max(40).optional(),
  /** The total the customer was shown. If prices changed since, the order is refused (PRICE_CHANGED) so nobody pays a price they did not see. */
  expectedTotalPaise: z.number().int().min(0).optional(),
})
export type CheckoutInput = z.infer<typeof checkoutInputSchema>

/** Pricing the cart needs no request key. */
export const quoteInputSchema = checkoutInputSchema.omit({ idempotencyKey: true, expectedTotalPaise: true })
export type QuoteInput = z.infer<typeof quoteInputSchema>

export const orderIdParamsSchema = z.object({ id: z.uuid('That is not a valid order id.') })

export const customerOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})
export type CustomerOrderListQuery = z.infer<typeof customerOrderListQuerySchema>

/** How an order was bought: a one-time purchase, or one delivery of a subscription or a trial. */
export const ORDER_SOURCES = ['one_time', 'subscription', 'trial'] as const
export type OrderSource = (typeof ORDER_SOURCES)[number]

export const adminOrderListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  status: z.enum(ORDER_STATUSES).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-15.').optional(),
  slotId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  /** One-time orders, subscription deliveries or trial deliveries; all when left out. */
  source: z.enum(ORDER_SOURCES).optional(),
  /** Only orders with this product in them. */
  productId: z.uuid().optional(),
  payment: z.enum(['credit', 'online']).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
})
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>

export const orderStatusChangeSchema = z.object({
  status: z.enum(ORDER_STATUSES).exclude(['placed']),
  note: z.string().trim().max(300).default(''),
})
export type OrderStatusChange = z.infer<typeof orderStatusChangeSchema>

export const cancelOrderSchema = z.object({ reason: z.string().trim().max(300).default('') })
export type CancelOrder = z.infer<typeof cancelOrderSchema>

/** Staff return the money for a missed or delivered order: why, in a few words (kept with the order and the refund). */
export const returnMoneySchema = z.object({ reason: z.string().trim().min(3, 'Say why, in a few words.').max(200, 'Keep it under 200 characters.') })
export type ReturnMoney = z.infer<typeof returnMoneySchema>

/** The courier and tracking link of a courier order. Both may be cleared with ''. */
export const courierSchema = z.object({
  courierName: z.string().trim().max(80, 'Keep the courier name under 80 characters.').default(''),
  trackingUrl: z.string().trim().max(500, 'That link is too long.').refine(value => value === '' || /^https?:\/\/\S+$/.test(value), 'Use a full link starting with https://.').default(''),
})
export type CourierInput = z.infer<typeof courierSchema>

/** One status step for many orders at once (for example "all of today's Morning deliveries are out"). */
export const bulkStatusSchema = z.object({
  orderIds: z.array(z.uuid()).min(1, 'Choose at least one order.').max(200, 'At most 200 orders at once.'),
  status: z.enum(ORDER_STATUSES).exclude(['placed', 'cancelled']),
  note: z.string().trim().max(300).default(''),
})
export type BulkStatus = z.infer<typeof bulkStatusSchema>
