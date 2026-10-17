import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { validate } from '../../http/validate.js'
import { requireAdmin, requireTrustedOrigin } from '../auth/middleware.js'
import type { AuthService } from '../auth/service.js'
import type { PinDirectoryRepository } from './repository.js'

type Options = { auth: AuthService; directory: PinDirectoryRepository; allowedOrigins: string[] }

/** Most PIN codes one district can return. No Indian district comes close, so this only guards against a bad file. */
export const MAX_DISTRICT_PINS = 1000

const stateQuery = z.object({ state: z.string().trim().min(1, 'Choose a state.').max(60) })
const districtQuery = stateQuery.extend({ district: z.string().trim().min(1, 'Choose a district.').max(80) })

/**
 * `/admin/pin-directory`: the national PIN list, used only to help staff pick PIN codes for a service area.
 * It never decides where you deliver; only the PIN codes added to a service area do that.
 */
export function createAdminPinDirectoryRouter({ auth, directory, allowedOrigins }: Options): Router {
  const router = Router()
  router.use(requireTrustedOrigin(allowedOrigins), requireAdmin(auth))

  router.get('/states', async (_request: Request, response: Response) => { response.json({ states: await directory.listStates() }) })
  router.get('/districts', validate('query', stateQuery), async (request: Request, response: Response) => {
    response.json({ districts: await directory.listDistricts((request.query as unknown as z.infer<typeof stateQuery>).state) })
  })
  router.get('/pins', validate('query', districtQuery), async (request: Request, response: Response) => {
    const { state, district } = request.query as unknown as z.infer<typeof districtQuery>
    response.json({ pins: await directory.listPins(state, district, MAX_DISTRICT_PINS) })
  })
  return router
}
