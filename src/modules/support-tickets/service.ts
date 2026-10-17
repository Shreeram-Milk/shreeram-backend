import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import type { SupportTicket, SupportTicketRepository, TicketMessage, TicketThread } from './repository.js'
import { MAX_NEW_TICKETS_PER_HOUR, TICKET_TRANSITIONS, type NewTicket, type TicketListQuery, type TicketStatus } from './schema.js'

type Actor = { adminId: string; ip: string | null }
type Dependencies = { repository: SupportTicketRepository; audit: AuditWriter; now?: () => Date }

const reference = (ticketNumber: number) => `TKT-${ticketNumber}`
const notFound = () => new AppError(404, 'TICKET_NOT_FOUND', 'That ticket was not found.')
const closed = () => new AppError(409, 'TICKET_CLOSED', 'This ticket is closed. Please open a new one.')

/** What a customer sees of a ticket: no staff names, no assignee, nothing internal. */
export type CustomerTicket = { id: string; reference: string; category: SupportTicket['category']; status: TicketStatus; messageCount: number; createdAt: string; updatedAt: string }
export type CustomerThread = { ticket: CustomerTicket; messages: Array<{ id: string; author: 'customer' | 'support'; body: string; createdAt: string }> }

const toCustomerTicket = (ticket: SupportTicket): CustomerTicket => ({ id: ticket.id, reference: reference(ticket.ticketNumber), category: ticket.category, status: ticket.status, messageCount: ticket.messageCount, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt })
const toCustomerThread = ({ ticket, messages }: TicketThread): CustomerThread => ({
  ticket: toCustomerTicket(ticket),
  messages: messages.map((message: TicketMessage) => ({ id: message.id, author: message.author === 'admin' ? 'support' : 'customer', body: message.body, createdAt: message.createdAt })),
})

/**
 * Support tickets: a customer reports a problem and can reply; staff read, reply, assign, move the status and close.
 * A ticket belongs to one customer, who can only ever see their own. Closed tickets accept nothing more.
 */
export function createSupportTicketService({ repository, audit, now = () => new Date() }: Dependencies) {
  return {
    // ---------------------------------------------------------------- the customer's side
    async createForCustomer(customerId: string, input: NewTicket): Promise<CustomerTicket> {
      const since = new Date(now().getTime() - 60 * 60_000)
      if ((await repository.countRecentForCustomer(customerId, since)) >= MAX_NEW_TICKETS_PER_HOUR) throw new AppError(429, 'TOO_MANY_TICKETS', 'You have sent several reports in the last hour. Please wait a little before sending another.')
      return toCustomerTicket(await repository.create({ customerId, category: input.category, description: input.description }))
    },

    async listForCustomer(customerId: string, page: number, pageSize: number): Promise<{ rows: CustomerTicket[]; total: number }> {
      const { rows, total } = await repository.list({ search: '', page, pageSize, forCustomerId: customerId })
      return { rows: rows.map(toCustomerTicket), total }
    },

    async getForCustomer(customerId: string, id: string): Promise<CustomerThread> {
      const thread = await repository.getThread(id, customerId)
      if (!thread) throw notFound()
      return toCustomerThread(thread)
    },

    async customerReply(customerId: string, id: string, body: string): Promise<CustomerThread> {
      const thread = await repository.getThread(id, customerId)
      if (!thread) throw notFound()
      if (thread.ticket.status === 'closed') throw closed()
      // A customer writing on a resolved ticket reopens it for staff.
      await repository.addMessage({ ticketId: id, author: 'customer', adminId: null, body, nextStatus: thread.ticket.status === 'resolved' ? 'open' : null })
      return this.getForCustomer(customerId, id)
    },

    // ---------------------------------------------------------------- staff's side
    list: (query: TicketListQuery) => repository.list(query),
    countNeedingAttention: () => repository.countNeedingAttention(),

    async get(id: string): Promise<TicketThread> {
      const thread = await repository.getThread(id)
      if (!thread) throw notFound()
      return thread
    },

    async reply(id: string, body: string, actor: Actor): Promise<TicketThread> {
      const thread = await this.get(id)
      if (thread.ticket.status === 'closed') throw closed()
      // The first staff reply on an untouched ticket means someone is on it.
      await repository.addMessage({ ticketId: id, author: 'admin', adminId: actor.adminId, body, nextStatus: thread.ticket.status === 'open' ? 'in_progress' : null })
      await audit({ adminId: actor.adminId, action: 'support_reply_sent', details: { ticketId: id }, ip: actor.ip })
      return this.get(id)
    },

    async changeStatus(id: string, status: TicketStatus, actor: Actor): Promise<TicketThread> {
      const thread = await this.get(id)
      const from = thread.ticket.status
      if (!TICKET_TRANSITIONS[from].includes(status)) throw new AppError(409, 'INVALID_TRANSITION', `A ${from.replace('_', ' ')} ticket cannot be moved to ${status.replace('_', ' ')}.`)
      await repository.setStatus(id, status, now())
      await audit({ adminId: actor.adminId, action: 'support_ticket_status_changed', details: { ticketId: id, from, to: status }, ip: actor.ip })
      return this.get(id)
    },

    /** Staff take a ticket (or hand it back). The assignee is always the signed-in admin, never someone chosen by name. */
    async assign(id: string, assigned: boolean, actor: Actor): Promise<TicketThread> {
      const thread = await this.get(id)
      if (thread.ticket.status === 'closed') throw closed()
      await repository.setAssignee(id, assigned ? actor.adminId : null)
      await audit({ adminId: actor.adminId, action: assigned ? 'support_ticket_taken' : 'support_ticket_released', details: { ticketId: id }, ip: actor.ip })
      return this.get(id)
    },
  }
}

export type SupportTicketService = ReturnType<typeof createSupportTicketService>
