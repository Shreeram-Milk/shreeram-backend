import { Router, type Request, type Response } from 'express'
import { validate } from '../../http/validate.js'
import { requireCustomer } from '../customer-auth/routes.js'
import type { CustomerAuthService } from '../customer-auth/service.js'
import type { Customer } from '../customer-auth/repository.js'
import { addressInputSchema, doorstepInstructionsSchema, recordIdParamsSchema, type AddressInput, type DoorstepInstructions } from './schema.js'
import type { CustomerAddressService } from './service.js'

type Options = { auth: CustomerAuthService; addresses: CustomerAddressService }

const customerIdOf = (request: Request) => (request.customer as Customer).id
const idOf = (request: Request) => (request.params as { id: string }).id

/** `/customer/addresses` and `/customer/doorstep-instructions`: a signed-in customer's own addresses only. Never cached. */
export function createCustomerAddressRouter({ auth, addresses }: Options): Router {
  const router = Router()
  router.use(requireCustomer(auth))
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })

  router.get('/addresses', async (request: Request, response: Response) => { response.json({ addresses: await addresses.list(customerIdOf(request)) }) })
  router.post('/addresses', validate('body', addressInputSchema), async (request: Request, response: Response) => {
    response.status(201).json({ address: await addresses.create(customerIdOf(request), request.body as AddressInput) })
  })
  router.put('/addresses/:id', validate('params', recordIdParamsSchema), validate('body', addressInputSchema), async (request: Request, response: Response) => {
    response.json({ address: await addresses.update(customerIdOf(request), idOf(request), request.body as AddressInput) })
  })
  router.delete('/addresses/:id', validate('params', recordIdParamsSchema), async (request: Request, response: Response) => {
    await addresses.remove(customerIdOf(request), idOf(request))
    response.status(204).end()
  })

  router.get('/doorstep-instructions', async (request: Request, response: Response) => { response.json({ instructions: await addresses.getInstructions(customerIdOf(request)) }) })
  router.put('/doorstep-instructions', validate('body', doorstepInstructionsSchema), async (request: Request, response: Response) => {
    response.json({ instructions: await addresses.saveInstructions(customerIdOf(request), request.body as DoorstepInstructions) })
  })
  return router
}
