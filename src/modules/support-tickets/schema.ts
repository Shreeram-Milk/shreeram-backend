import { z } from 'zod'
import { recordIdParamsSchema } from '../master-data/shared.js'

export const TICKET_CATEGORIES = ['delivery_missing', 'late_delivery', 'wrong_product', 'quality_issue', 'payment_issue', 'subscription_issue', 'address_issue', 'other'] as const
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/** Which status a ticket may move to next. Closed is final; a resolved ticket can be reopened. */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['in_progress', 'resolved'],
  in_progress: ['resolved'],
  resolved: ['closed', 'in_progress'],
  closed: [],
}

export const MESSAGE_MAX_LENGTH = 1000
export const NEW_TICKET_MIN_LENGTH = 10
/** A customer may open this many tickets in an hour: enough for a real problem, too few to flood the support team. */
export const MAX_NEW_TICKETS_PER_HOUR = 5

const messageBody = (min: number) => z.string().trim().min(min, min > 1 ? `Tell us a little more (at least ${min} characters).` : 'Write a message first.').max(MESSAGE_MAX_LENGTH, `Keep this under ${MESSAGE_MAX_LENGTH} characters.`)

/** What a customer sends to report a problem. */
export const newTicketSchema = z.object({ category: z.enum(TICKET_CATEGORIES), description: messageBody(NEW_TICKET_MIN_LENGTH) })
export type NewTicket = z.infer<typeof newTicketSchema>

export const messageSchema = z.object({ body: messageBody(1) })
export type MessageInput = z.infer<typeof messageSchema>

export const statusChangeSchema = z.object({ status: z.enum(TICKET_STATUSES) })
export const assigneeSchema = z.object({ assigned: z.boolean() })

export const ticketListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  customerId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>

export { recordIdParamsSchema }
