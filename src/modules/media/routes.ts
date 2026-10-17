import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import { mediaIdParamsSchema, uploadRequestSchema, type UploadRequest } from './schema.js'
import type { MediaService } from './service.js'

type Options = { auth: AuthService; media: MediaService; allowedOrigins: string[] }

const actorOf = (request: Request) => ({ adminId: (request.admin as { id: string }).id, ip: request.ip ?? null })

/** `/admin/media`: only a signed-in admin can ask to upload a picture. The file itself goes straight to storage. */
export function createAdminMediaRouter({ auth, media, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.post('/uploads', validate('body', uploadRequestSchema), async (request: Request, response: Response) => {
    response.status(201).json(await media.startUpload(request.body as UploadRequest, actorOf(request)))
  })
  router.post('/:id/complete', validate('params', mediaIdParamsSchema), async (request: Request, response: Response) => {
    response.json(await media.completeUpload((request.params as { id: string }).id, actorOf(request)))
  })
  return router
}
