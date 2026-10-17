import { Router, type Request, type Response } from 'express'
import { AppError } from '../../http/errors.js'
import { validate } from '../../http/validate.js'
import { PaymentGatewayError } from '../../integrations/payments/gateway.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import { adminPaymentListQuerySchema, merchantOrderParamsSchema, paymentIdParamsSchema, webhookSchema, type AdminPaymentListQuery } from './schema.js'
import type { PaymentService } from './service.js'

/** `/customer/payments`: the payer asks how their payment stands (after PhonePe's screen closes). Never cached. */
export function createCustomerPaymentRouter({ auth, payments }: { auth: CustomerAuthService; payments: PaymentService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.post('/:merchantOrderId/confirm', validate('params', merchantOrderParamsSchema), async (request: Request, response: Response) => {
    const { merchantOrderId } = request.params as { merchantOrderId: string }
    response.json({ payment: await payments.confirm((request.customer as Customer).id, merchantOrderId) })
  })
  return router
}

/** `/admin/payments`: staff see every online payment, its step-by-step history, and can ask PhonePe again. */
export function createAdminPaymentRouter({ auth, payments, allowedOrigins }: { auth: AuthService; payments: PaymentService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  const idOf = (request: Request) => (request.params as { id: string }).id
  router.get('/', validate('query', adminPaymentListQuerySchema), async (request: Request, response: Response) => {
    response.json(await payments.adminList(request.query as unknown as AdminPaymentListQuery))
  })
  router.get('/:id', validate('params', paymentIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ payment: await payments.adminGet(idOf(request)) })
  })
  router.post('/:id/check', validate('params', paymentIdParamsSchema), async (request: Request, response: Response) => {
    response.json({ payment: await payments.adminRecheck(idOf(request)) })
  })
  return router
}

/**
 * `/webhooks/phonepe`: PhonePe's server tells us a payment finished. No session (PhonePe has none); the Authorization header is
 * checked instead, and the body is only used to find the payment. Answers quickly: PhonePe expects a reply within 3 to 5 seconds.
 */
export function createPhonePeWebhookRouter({ payments }: { payments: PaymentService }): Router {
  const router = Router()
  router.post('/', validate('body', webhookSchema), async (request: Request, response: Response) => {
    try {
      await payments.webhook(request.get('authorization'), request.body)
    } catch (error) {
      // PhonePe unreachable while confirming: answer with an error so PhonePe sends the webhook again (the background check is a second net).
      if (error instanceof PaymentGatewayError) throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Try again later.')
      throw error
    }
    response.json({ received: true })
  })
  return router
}
