import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import { assigneeSchema, messageSchema, newTicketSchema, recordIdParamsSchema, statusChangeSchema, ticketListQuerySchema, type MessageInput, type NewTicket, type TicketListQuery } from './schema.js'
import type { SupportTicketService } from './service.js'
import { z } from 'zod'

const idOf = (request: Request) => (request.params as { id: string }).id
const customerIdOf = (request: Request) => (request.customer as Customer).id
const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })

const customerPageQuery = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) })

/** `/customer/support/tickets`: a signed-in customer reports a problem, sees their own reports, and replies. Never cached. */
export function createCustomerSupportRouter({ auth, tickets }: { auth: CustomerAuthService; tickets: SupportTicketService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.post('/tickets', validate('body', newTicketSchema), async (request: Request, response: Response) => {
    response.status(201).json({ ticket: await tickets.createForCustomer(customerIdOf(request), request.body as NewTicket) })
  })
  router.get('/tickets', validate('query', customerPageQuery), async (request: Request, response: Response) => {
    const { page, pageSize } = request.query as unknown as z.infer<typeof customerPageQuery>
    response.json(await tickets.listForCustomer(customerIdOf(request), page, pageSize))
  })
  router.get('/tickets/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json(await tickets.getForCustomer(customerIdOf(request), idOf(request))) })
  router.post('/tickets/:id/messages', validate('params', recordIdParamsSchema), validate('body', messageSchema), async (request: Request, response: Response) => {
    response.status(201).json(await tickets.customerReply(customerIdOf(request), idOf(request), (request.body as MessageInput).body))
  })
  return router
}

/** `/admin/support-tickets`: only a signed-in admin can read, answer and manage tickets. Never cached. */
export function createAdminSupportRouter({ auth, tickets, allowedOrigins }: { auth: AuthService; tickets: SupportTicketService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.get('/', validate('query', ticketListQuerySchema), async (request: Request, response: Response) => { response.json(await tickets.list(request.query as unknown as TicketListQuery)) })
  router.get('/needs-attention', async (_request: Request, response: Response) => { response.json({ count: await tickets.countNeedingAttention() }) })
  router.get('/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => { response.json(await tickets.get(idOf(request))) })
  router.post('/:id/messages', validate('params', recordIdParamsSchema), validate('body', messageSchema), async (request: Request, response: Response) => {
    response.status(201).json(await tickets.reply(idOf(request), (request.body as MessageInput).body, actorOf(request)))
  })
  router.patch('/:id/status', validate('params', recordIdParamsSchema), validate('body', statusChangeSchema), async (request: Request, response: Response) => {
    response.json(await tickets.changeStatus(idOf(request), (request.body as z.infer<typeof statusChangeSchema>).status, actorOf(request)))
  })
  router.put('/:id/assignee', validate('params', recordIdParamsSchema), validate('body', assigneeSchema), async (request: Request, response: Response) => {
    response.json(await tickets.assign(idOf(request), (request.body as z.infer<typeof assigneeSchema>).assigned, actorOf(request)))
  })
  return router
}
