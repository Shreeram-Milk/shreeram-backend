import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import type { CustomerAddress, CustomerAddressRepository } from '../customer-addresses/repository.js'
import type { DoorstepInstructions } from '../customer-addresses/schema.js'
import type { AdminCustomer, CustomerRepository } from './repository.js'
import type { CustomerListQuery, CustomerUpdate } from './schema.js'

type Actor = { adminId: string; ip: string | null }
type Dependencies = { repository: CustomerRepository; addresses: Pick<CustomerAddressRepository, 'list' | 'getInstructions'>; audit: AuditWriter }

const notFound = () => new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.')

/**
 * What staff can do with customers: look them up, correct their name, add a note, and choose prepaid or credit.
 * Customers are never created or deleted here: they sign up in the app, and an account deletion is the customer's own act.
 * Blocking signs the customer out at once, because a session only counts while the customer is active.
 */
export function createCustomerService({ repository, addresses, audit }: Dependencies) {
  return {
    list: (query: CustomerListQuery) => repository.list(query),

    async get(id: string): Promise<AdminCustomer> {
      const customer = await repository.findById(id)
      if (!customer) throw notFound()
      return customer
    },

    /** Read-only: where this customer lives and how they want deliveries handled. Staff cannot change them; the customer does. */
    async getAddresses(id: string): Promise<{ addresses: CustomerAddress[]; instructions: DoorstepInstructions }> {
      if (!(await repository.findById(id))) throw notFound()
      const [list, instructions] = await Promise.all([addresses.list(id), addresses.getInstructions(id)])
      return { addresses: list, instructions }
    },

    async update(id: string, changes: CustomerUpdate, actor: Actor): Promise<AdminCustomer> {
      const existing = await repository.findById(id)
      if (!existing) throw notFound()
      if (existing.status === 'deleted') throw new AppError(409, 'CUSTOMER_DELETED', 'This customer deleted their account and cannot be changed.')
      // Switching credit to prepaid will also check the outstanding balance once credit accounts exist (the credit bundle).
      const updated = await repository.update(id, changes)
      if (!updated) throw new AppError(409, 'CUSTOMER_DELETED', 'This customer deleted their account and cannot be changed.')
      const changed = (['name', 'customerType', 'adminNote'] as const).filter(field => existing[field] !== updated[field])
      // Field names only: the audit log never holds names, emails, phone numbers or notes.
      if (changed.length > 0) await audit({ adminId: actor.adminId, action: 'customer_updated', details: { customerId: id, fields: changed }, ip: actor.ip })
      return updated
    },
  }
}

export type CustomerService = ReturnType<typeof createCustomerService>
