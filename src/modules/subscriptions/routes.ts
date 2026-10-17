import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import {
  adminSubscriptionListQuerySchema, cancelSubscriptionSchema, createSubscriptionSchema, deliveriesQuerySchema, pauseSchema, resumeSchema, skipSchema, subscriptionDraftSchema, subscriptionIdParamsSchema,
  type AdminSubscriptionListQuery, type CancelSubscriptionInput, type CreateSubscriptionInput, type DeliveriesQuery, type PauseInput, type ResumeInput, type SkipInput, type SubscriptionDraftInput,
} from './schema.js'
import type { SubscriptionService } from './service.js'

const idOf = (request: Request) => (request.params as { id: string }).id

/** `/customer/subscriptions` and `/customer/deliveries`: a signed-in customer's own subscriptions, trials and delivery calendar. Never cached. */
export function createCustomerSubscriptionRouter({ auth, subscriptions }: { auth: CustomerAuthService; subscriptions: SubscriptionService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  const customerIdOf = (request: Request) => (request.customer as Customer).id
  const params = validate('params', subscriptionIdParamsSchema)

  router.post('/subscriptions/quote', validate('body', subscriptionDraftSchema), async (request: Request, response: Response) => {
    response.json({ quote: await subscriptions.quote(customerIdOf(request), request.body as SubscriptionDraftInput) })
  })
  router.post('/subscriptions', validate('body', createSubscriptionSchema), async (request: Request, response: Response) => {
    response.status(201).json(await subscriptions.create(customerIdOf(request), request.body as CreateSubscriptionInput))
  })
  router.get('/subscriptions', async (request: Request, response: Response) => {
    response.json({ subscriptions: await subscriptions.listMine(customerIdOf(request)) })
  })
  router.get('/subscriptions/:id', params, async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.getMine(customerIdOf(request), idOf(request)) })
  })
  router.post('/subscriptions/:id/skip', params, validate('body', skipSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.skipMine(customerIdOf(request), idOf(request), request.body as SkipInput) })
  })
  router.post('/subscriptions/:id/unskip', params, validate('body', skipSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.unskipMine(customerIdOf(request), idOf(request), request.body as SkipInput) })
  })
  router.post('/subscriptions/:id/pause', params, validate('body', pauseSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.pauseMine(customerIdOf(request), idOf(request), request.body as PauseInput) })
  })
  router.post('/subscriptions/:id/resume', params, validate('body', resumeSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.resumeMine(customerIdOf(request), idOf(request), request.body as ResumeInput) })
  })
  router.post('/subscriptions/:id/cancel', params, validate('body', cancelSubscriptionSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.cancelMine(customerIdOf(request), idOf(request), request.body as CancelSubscriptionInput) })
  })
  router.get('/deliveries', validate('query', deliveriesQuerySchema), async (request: Request, response: Response) => {
    response.json({ deliveries: await subscriptions.deliveries(customerIdOf(request), request.query as unknown as DeliveriesQuery) })
  })
  return router
}

/** `/admin/subscriptions`: staff see every subscription and trial, act on a customer's behalf, and can run the delivery job now. */
export function createAdminSubscriptionRouter({ auth, subscriptions, allowedOrigins }: { auth: AuthService; subscriptions: SubscriptionService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })
  const params = validate('params', subscriptionIdParamsSchema)

  router.get('/', validate('query', adminSubscriptionListQuerySchema), async (request: Request, response: Response) => {
    response.json(await subscriptions.adminList(request.query as unknown as AdminSubscriptionListQuery))
  })
  /** Makes the coming days' delivery orders now, instead of waiting for the next automatic run. */
  router.post('/run', async (_request: Request, response: Response) => {
    response.json({ result: await subscriptions.generate() })
  })
  router.get('/:id', params, async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.adminGet(idOf(request)) })
  })
  router.post('/:id/skip', params, validate('body', skipSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.adminSkip(idOf(request), request.body as SkipInput, actorOf(request)) })
  })
  router.post('/:id/unskip', params, validate('body', skipSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.adminUnskip(idOf(request), request.body as SkipInput, actorOf(request)) })
  })
  router.post('/:id/pause', params, validate('body', pauseSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.adminPause(idOf(request), request.body as PauseInput, actorOf(request)) })
  })
  router.post('/:id/resume', params, validate('body', resumeSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.adminResume(idOf(request), request.body as ResumeInput, actorOf(request)) })
  })
  router.post('/:id/cancel', params, validate('body', cancelSubscriptionSchema), async (request: Request, response: Response) => {
    response.json({ subscription: await subscriptions.adminCancel(idOf(request), request.body as CancelSubscriptionInput, actorOf(request)) })
  })
  return router
}
