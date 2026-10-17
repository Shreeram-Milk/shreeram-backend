import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { validate } from '../../http/validate.js'
import type { DeliveryBrainService } from './service.js'

const checkQuerySchema = z.object({
  pin: z.string().trim().max(10),
  productId: z.uuid('That is not a valid product id.'),
})

const pinQuerySchema = z.object({ pin: z.string().trim().max(10) })

/**
 * `/public/delivery/check?pin=382010&productId=…`: can we deliver this product to this PIN, and from when?
 * No sign-in (customers check before they have an account) and nothing private in the answer.
 * It depends on the clock, so the browser and any cache are told not to keep it.
 */
export function createPublicDeliveryRouter({ delivery }: { delivery: DeliveryBrainService }): Router {
  const router = Router()
  router.get('/check', validate('query', checkQuerySchema), async (request: Request, response: Response) => {
    const { pin, productId } = request.query as unknown as z.infer<typeof checkQuerySchema>
    response.set('Cache-Control', 'no-store').json(await delivery.check(pin, productId))
  })
  // Before any product is chosen: which of our ways of delivering serve this PIN. Used by the Location screen.
  router.get('/check-pin', validate('query', pinQuerySchema), async (request: Request, response: Response) => {
    const { pin } = request.query as unknown as z.infer<typeof pinQuerySchema>
    response.set('Cache-Control', 'no-store').json({ pin, options: await delivery.servedOptions(pin) })
  })
  return router
}
