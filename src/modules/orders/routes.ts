import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import {
  adminOrderListQuerySchema, bulkStatusSchema, cancelOrderSchema, checkoutInputSchema, courierSchema, customerOrderListQuerySchema, orderIdParamsSchema, orderStatusChangeSchema, quoteInputSchema, returnMoneySchema,
  type AdminOrderListQuery, type BulkStatus, type CancelOrder, type CheckoutInput, type CourierInput, type CustomerOrderListQuery, type OrderStatusChange, type QuoteInput, type ReturnMoney,
} from './schema.js'
import type { OrderService } from './service.js'

const customerIdOf = (request: Request) => (request.customer as Customer).id
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/customer/orders`: a signed-in customer prices a cart, places orders, and reads or cancels only their own. Never cached. */
export function createCustomerOrderRouter({ auth, orders }: { auth: CustomerAuthService; orders: OrderService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.post('/orders/quote', validate('body', quoteInputSchema), async (request: Request, response: Response) => {
    response.json({ quote: await orders.quote(customerIdOf(request), request.body as QuoteInput) })
  })
  router.post('/orders', validate('body', checkoutInputSchema), async (request: Request, response: Response) => {
    response.status(201).json(await orders.place(customerIdOf(request), request.body as CheckoutInput))
  })
  // Anything paid online: starts the payment; the orders are written once PhonePe confirms it (see /customer/payments).
  router.post('/orders/payments', validate('body', checkoutInputSchema), async (request: Request, response: Response) => {
    response.status(201).json(await orders.startPayment(customerIdOf(request), request.body as CheckoutInput))
  })
  router.get('/orders', validate('query', customerOrderListQuerySchema), async (request: Request, response: Response) => {
    response.json(await orders.listMine(customerIdOf(request), request.query as unknown as CustomerOrderListQuery))
  })
  router.get('/orders/:id', validate('params', orderIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ order: await orders.getMine(customerIdOf(request), idOf(request)) })
  })
  router.post('/orders/:id/cancel', validate('params', orderIdParamsSchema), validate('body', cancelOrderSchema), async (request: Request, response: Response) => {
    response.json({ order: await orders.cancelMine(customerIdOf(request), idOf(request), (request.body as CancelOrder).reason) })
  })
  return router
}

/** `/admin/orders`: staff see every order and move it along (out for delivery, delivered, missed, cancelled). */
export function createAdminOrderRouter({ auth, orders, allowedOrigins }: { auth: AuthService; orders: OrderService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })

  router.get('/', validate('query', adminOrderListQuerySchema), async (request: Request, response: Response) => {
    response.json(await orders.adminList(request.query as unknown as AdminOrderListQuery))
  })
  router.get('/:id', validate('params', orderIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ order: await orders.adminGet(idOf(request)) })
  })
  router.post('/bulk-status', validate('body', bulkStatusSchema), async (request: Request, response: Response) => {
    response.json(await orders.adminBulkStatus(request.body as BulkStatus, actorOf(request)))
  })
  router.post('/:id/status', validate('params', orderIdParamsSchema), validate('body', orderStatusChangeSchema), async (request: Request, response: Response) => {
    response.json({ order: await orders.adminSetStatus(idOf(request), request.body as OrderStatusChange, actorOf(request)) })
  })
  router.post('/:id/return-money', validate('params', orderIdParamsSchema), validate('body', returnMoneySchema), async (request: Request, response: Response) => {
    response.json({ order: await orders.adminReturnMoney(idOf(request), request.body as ReturnMoney, actorOf(request)) })
  })
  router.put('/:id/courier', validate('params', orderIdParamsSchema), validate('body', courierSchema), async (request: Request, response: Response) => {
    response.json({ order: await orders.adminSetCourier(idOf(request), request.body as CourierInput, actorOf(request)) })
  })
  return router
}
