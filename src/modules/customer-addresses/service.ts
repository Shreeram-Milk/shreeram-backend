import { AppError } from '../../http/errors.js'
import type { DeliveryBrainService } from '../delivery-brain/service.js'
import type { CustomerAddress, CustomerAddressRepository } from './repository.js'
import { MAX_ADDRESSES_PER_CUSTOMER, type AddressInput, type DoorstepInstructions } from './schema.js'

/** An address plus whether any of your delivery rules serve its PIN right now. Worked out each time, never stored. */
export type AddressView = CustomerAddress & { serviceable: boolean }

const notFound = () => new AppError(404, 'ADDRESS_NOT_FOUND', 'That address was not found.')

type Dependencies = { repository: CustomerAddressRepository; delivery: Pick<DeliveryBrainService, 'servedOptions'> }

/**
 * A customer's saved addresses and delivery preferences. Whether an address can be delivered to is asked of the delivery
 * check (one question per distinct PIN), so changing a service area in the admin changes the answer straight away.
 */
export function createCustomerAddressService({ repository, delivery }: Dependencies) {
  async function withServiceability(addresses: CustomerAddress[]): Promise<AddressView[]> {
    const pins = [...new Set(addresses.map(address => address.pinCode))]
    const served = new Map(await Promise.all(pins.map(async pin => [pin, (await delivery.servedOptions(pin)).length > 0] as const)))
    return addresses.map(address => ({ ...address, serviceable: served.get(address.pinCode) ?? false }))
  }

  return {
    async list(customerId: string): Promise<AddressView[]> {
      return withServiceability(await repository.list(customerId))
    },

    async create(customerId: string, input: AddressInput): Promise<AddressView> {
      if ((await repository.list(customerId)).length >= MAX_ADDRESSES_PER_CUSTOMER) throw new AppError(409, 'TOO_MANY_ADDRESSES', `You can save up to ${MAX_ADDRESSES_PER_CUSTOMER} addresses. Remove one to add another.`)
      const [view] = await withServiceability([await repository.create(customerId, input)])
      return view as AddressView
    },

    async update(customerId: string, id: string, input: AddressInput): Promise<AddressView> {
      const updated = await repository.update(customerId, id, input)
      if (!updated) throw notFound()
      const [view] = await withServiceability([updated])
      return view as AddressView
    },

    async remove(customerId: string, id: string): Promise<void> {
      if (!(await repository.remove(customerId, id))) throw notFound()
    },

    getInstructions: (customerId: string): Promise<DoorstepInstructions> => repository.getInstructions(customerId),
    saveInstructions: (customerId: string, instructions: DoorstepInstructions): Promise<DoorstepInstructions> => repository.saveInstructions(customerId, instructions),
  }
}

export type CustomerAddressService = ReturnType<typeof createCustomerAddressService>
