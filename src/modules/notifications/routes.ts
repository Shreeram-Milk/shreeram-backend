import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import {
  audiencePreviewSchema, broadcastListQuerySchema, broadcastSchema, eventParamsSchema, notificationIdParamsSchema, notificationListQuerySchema, registerTokenSchema, templateUpdateSchema, unregisterTokenSchema,
  type Audience, type BroadcastInput, type BroadcastListQuery, type NotificationListQuery, type RegisterTokenInput, type TemplateUpdateInput,
} from './schema.js'
import type { NotificationEventKey } from './events.js'
import type { NotificationService } from './service.js'

const customerIdOf = (request: Request) => (request.customer as Customer).id

/**
 * `/customer/push-tokens` and `/customer/notifications`: a signed-in customer registers their phone for notifications and reads
 * their own messages (the bell). Never cached; nobody can read or change another customer's messages.
 */
export function createCustomerNotificationRouter({ auth, notifications }: { auth: CustomerAuthService; notifications: NotificationService }): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.post('/push-tokens', validate('body', registerTokenSchema), async (request: Request, response: Response) => {
    await notifications.registerToken(customerIdOf(request), request.body as RegisterTokenInput)
    response.status(204).end()
  })
  router.post('/push-tokens/remove', validate('body', unregisterTokenSchema), async (request: Request, response: Response) => {
    await notifications.unregisterToken(customerIdOf(request), (request.body as { token: string }).token)
    response.status(204).end()
  })
  router.get('/notifications', validate('query', notificationListQuerySchema), async (request: Request, response: Response) => {
    response.json(await notifications.listMine(customerIdOf(request), request.query as unknown as NotificationListQuery))
  })
  router.get('/notifications/unread-count', async (request: Request, response: Response) => { response.json({ unread: await notifications.unreadCount(customerIdOf(request)) }) })
  router.post('/notifications/read-all', async (request: Request, response: Response) => { response.json({ updated: await notifications.markAllRead(customerIdOf(request)) }) })
  router.post('/notifications/:id/read', validate('params', notificationIdParamsSchema), async (request: Request, response: Response) => {
    await notifications.markRead(customerIdOf(request), (request.params as { id: string }).id)
    response.status(204).end()
  })
  return router
}

/** `/admin/notifications`: staff edit the wording of the automatic messages and send a message to a group of customers. */
export function createAdminNotificationRouter({ auth, notifications, allowedOrigins }: { auth: AuthService; notifications: NotificationService; allowedOrigins: string[] }): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))
  const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })

  router.get('/templates', async (_request: Request, response: Response) => { response.json({ templates: await notifications.listTemplates() }) })
  router.put('/templates/:event', validate('params', eventParamsSchema), validate('body', templateUpdateSchema), async (request: Request, response: Response) => {
    response.json({ template: await notifications.updateTemplate((request.params as { event: NotificationEventKey }).event, request.body as TemplateUpdateInput, actorOf(request)) })
  })
  router.post('/audience', validate('body', audiencePreviewSchema), async (request: Request, response: Response) => {
    response.json(await notifications.previewAudience((request.body as { audience: Audience }).audience))
  })
  router.get('/broadcasts', validate('query', broadcastListQuerySchema), async (request: Request, response: Response) => {
    response.json(await notifications.listBroadcasts(request.query as unknown as BroadcastListQuery))
  })
  router.post('/broadcasts', validate('body', broadcastSchema), async (request: Request, response: Response) => {
    response.status(201).json({ broadcast: await notifications.createBroadcast(request.body as BroadcastInput, actorOf(request)) })
  })
  return router
}
