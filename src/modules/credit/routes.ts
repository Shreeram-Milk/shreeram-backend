import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import {
  adjustmentSchema, creditAccountListQuerySchema, creditLimitSchema, customerIdParamsSchema, customerRequestParamsSchema, ledgerQuerySchema, paymentRequestSchema, recordPaymentSchema, requestParamsSchema,
  type AdjustmentInput, type CreditAccountListQuery, type CreditLimitInput, type LedgerQuery, type PaymentRequestInput, type RecordPaymentInput,
} from './schema.js'
import { startRequestPaymentSchema, type StartRequestPayment } from '../payments/schema.js'
import type { CreditService } from './service.js'

const customerOf = (request: Request) => (request.params as { customerId: string }).customerId

/** `/admin/credit-accounts`: staff see what each credit customer owes, set the limit, and record payments, corrections and payment requests. */
export function createAdminCreditRouter({ auth, credit, allowedOrigins }: { auth: AuthService; credit: CreditService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })

  router.get('/', validate('query', creditAccountListQuerySchema), async (request: Request, response: Response) => { response.json(await credit.listAccounts(request.query as unknown as CreditAccountListQuery)) })
  router.get('/:customerId', validate('params', customerIdParamsSchema), async (request: Request, response: Response) => { response.json(await credit.get(customerOf(request))) })
  router.get('/:customerId/ledger', validate('params', customerIdParamsSchema), validate('query', ledgerQuerySchema), async (request: Request, response: Response) => {
    response.json(await credit.ledger(customerOf(request), request.query as unknown as LedgerQuery))
  })
  router.put('/:customerId/limit', validate('params', customerIdParamsSchema), validate('body', creditLimitSchema), async (request: Request, response: Response) => {
    response.json({ account: await credit.setLimit(customerOf(request), (request.body as CreditLimitInput).limitPaise, actorOf(request)) })
  })
  router.post('/:customerId/payments', validate('params', customerIdParamsSchema), validate('body', recordPaymentSchema), async (request: Request, response: Response) => {
    response.status(201).json({ account: await credit.recordPayment(customerOf(request), request.body as RecordPaymentInput, actorOf(request)) })
  })
  router.post('/:customerId/adjustments', validate('params', customerIdParamsSchema), validate('body', adjustmentSchema), async (request: Request, response: Response) => {
    response.status(201).json({ account: await credit.addAdjustment(customerOf(request), request.body as AdjustmentInput, actorOf(request)) })
  })
  router.post('/:customerId/payment-requests', validate('params', customerIdParamsSchema), validate('body', paymentRequestSchema), async (request: Request, response: Response) => {
    response.status(201).json({ request: await credit.createRequest(customerOf(request), request.body as PaymentRequestInput, actorOf(request)) })
  })
  router.post('/:customerId/payment-requests/:requestId/cancel', validate('params', requestParamsSchema), async (request: Request, response: Response) => {
    const { requestId } = request.params as { customerId: string; requestId: string }
    response.json({ request: await credit.cancelRequest(customerOf(request), requestId, actorOf(request)) })
  })
  return router
}

/** `/customer/credit`: a credit customer sees their limit, what they owe and open "pay now" requests, and can pay one. */
export function createCustomerCreditRouter({ auth, credit }: { auth: CustomerAuthService; credit: CreditService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  const customerId = (request: Request) => (request.customer as Customer).id

  router.get('/credit', async (request: Request, response: Response) => { response.json(await credit.mine(customerId(request))) })
  router.post('/payment-requests/:id/pay', validate('params', customerRequestParamsSchema), validate('body', startRequestPaymentSchema), async (request: Request, response: Response) => {
    response.status(201).json(await credit.startRequestPayment(customerId(request), (request.params as { id: string }).id, (request.body as StartRequestPayment).idempotencyKey))
  })
  return router
}
