import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import {
  adminRefundListSchema, cancelRefundSchema, markRefundSentSchema, refundIdParamsSchema, refundRequestSchema, topUpSchema, walletAdjustmentSchema, walletCustomerListSchema, walletCustomerParamsSchema, walletPageSchema,
  type AdminRefundListQuery, type CancelRefundInput, type MarkRefundSentInput, type RefundRequestInput, type TopUpInput, type WalletAdjustmentInput, type WalletCustomerListQuery, type WalletPageQuery,
} from './schema.js'
import type { WalletService } from './service.js'

/** `/customer/wallet`: the signed-in customer's own wallet. Nothing here is ever cached. */
export function createCustomerWalletRouter({ auth, wallet }: { auth: CustomerAuthService; wallet: WalletService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  const customerId = (request: Request) => (request.customer as Customer).id

  router.get('/', async (request: Request, response: Response) => { response.json({ wallet: await wallet.mine(customerId(request)) }) })
  router.get('/entries', validate('query', walletPageSchema), async (request: Request, response: Response) => {
    response.json(await wallet.history(customerId(request), request.query as unknown as WalletPageQuery))
  })
  router.post('/top-ups', validate('body', topUpSchema), async (request: Request, response: Response) => {
    response.status(201).json(await wallet.startTopUp(customerId(request), request.body as TopUpInput))
  })
  router.get('/refund-requests', async (request: Request, response: Response) => { response.json({ requests: await wallet.refunds(customerId(request)) }) })
  router.post('/refund-requests', validate('body', refundRequestSchema), async (request: Request, response: Response) => {
    response.status(201).json({ request: await wallet.requestRefund(customerId(request), request.body as RefundRequestInput) })
  })
  return router
}

/** `/admin/wallet`: staff see refund requests, mark them sent (after refunding in PhonePe) or cancel them, and correct a balance. */
export function createAdminWalletRouter({ auth, wallet, allowedOrigins }: { auth: AuthService; wallet: WalletService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
  const idOf = (request: Request) => (request.params as { id: string }).id
  const customerOf = (request: Request) => (request.params as { customerId: string }).customerId

  router.get('/refund-requests', validate('query', adminRefundListSchema), async (request: Request, response: Response) => {
    response.json(await wallet.listRefunds(request.query as unknown as AdminRefundListQuery))
  })
  router.get('/refund-requests/:id', validate('params', refundIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ request: await wallet.getRefund(idOf(request)) })
  })
  router.post('/refund-requests/:id/sent', validate('params', refundIdParamsSchema), validate('body', markRefundSentSchema), async (request: Request, response: Response) => {
    response.json({ request: await wallet.markSent(idOf(request), request.body as MarkRefundSentInput, actorOf(request)) })
  })
  router.post('/refund-requests/:id/cancel', validate('params', refundIdParamsSchema), validate('body', cancelRefundSchema), async (request: Request, response: Response) => {
    response.json({ request: await wallet.cancelRefund(idOf(request), request.body as CancelRefundInput, actorOf(request)) })
  })
  router.get('/customers', validate('query', walletCustomerListSchema), async (request: Request, response: Response) => {
    response.json(await wallet.listCustomers(request.query as unknown as WalletCustomerListQuery))
  })
  router.get('/customers/:customerId', validate('params', walletCustomerParamsSchema), validate('query', walletPageSchema), async (request: Request, response: Response) => {
    response.json(await wallet.customerWallet(customerOf(request), request.query as unknown as WalletPageQuery))
  })
  router.post('/customers/:customerId/adjustments', validate('params', walletCustomerParamsSchema), validate('body', walletAdjustmentSchema), async (request: Request, response: Response) => {
    response.status(201).json({ wallet: await wallet.adjust(customerOf(request), request.body as WalletAdjustmentInput, actorOf(request)) })
  })
  return router
}
