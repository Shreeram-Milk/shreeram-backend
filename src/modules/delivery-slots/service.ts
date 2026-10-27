import type { AuditWriter } from '../audit/audit.js'
import { ValidationError } from '../../http/validate.js'
import { assertCanDeactivate, assertCanDelete, nameTakenError, notFoundError, type PageQuery, type StatusChange, type Usage } from '../master-data/shared.js'
import type { DeliverySlot, DeliverySlotRepository } from './repository.js'
import type { DeliverySlotInput } from './schema.js'

type Dependencies = { repository: DeliverySlotRepository; audit: AuditWriter }
type Actor = { adminId: string; ip: string | null }

const notFound = () => notFoundError('DELIVERY_SLOT_NOT_FOUND', 'delivery slot')

export function createDeliverySlotService({ repository, audit }: Dependencies) {
  async function get(id: string): Promise<DeliverySlot> {
    const slot = await repository.findById(id)
    if (!slot) throw notFound()
    return slot
  }

  return {
    list: (query: PageQuery) => repository.list(query),
    listAll: () => repository.listAll(),
    get,

    async usage(id: string): Promise<Usage[]> {
      await get(id)
      return repository.usage(id)
    },

    async create(input: DeliverySlotInput, actor: Actor): Promise<DeliverySlot> {
      if (await repository.nameExists(input.name)) throw nameTakenError()
      const slot = await repository.create(input, actor.adminId)
      await audit({ adminId: actor.adminId, action: 'delivery_slot_created', details: { slotId: slot.id }, ip: actor.ip })
      return slot
    },

    async update(id: string, input: DeliverySlotInput, actor: Actor): Promise<DeliverySlot> {
      const current = await get(id)
      if (await repository.nameExists(input.name, id)) throw nameTakenError()
      // Moving the start earlier must not leave an order-by rule that keeps ordering open after the milk is already on the road.
      if (current.startTime !== input.startTime) {
        const late = await repository.sameDayRulesClosingAfter(id, input.startTime)
        if (late.length > 0) throw new ValidationError([{ field: 'startTime', message: `Order-by time${late.length === 1 ? '' : 's'} ${late.join(', ')} would close after this window starts at ${input.startTime}. Change ${late.length === 1 ? 'it' : 'them'} first, or choose a later start.` }])
      }
      // Saving the form with "inactive" is a switch-off too, so it gets the same in-use check.
      if (current.status === 'active' && input.status === 'inactive') assertCanDeactivate(await repository.usage(id), { status: 'inactive', confirmInUse: false }, 'delivery slot')
      const slot = await repository.update(id, input, actor.adminId)
      if (!slot) throw notFound()
      await audit({ adminId: actor.adminId, action: 'delivery_slot_updated', details: { slotId: id }, ip: actor.ip })
      return slot
    },

    async setStatus(id: string, change: StatusChange, actor: Actor): Promise<DeliverySlot> {
      await get(id)
      assertCanDeactivate(await repository.usage(id), change, 'delivery slot')
      const slot = await repository.setStatus(id, change.status, actor.adminId)
      if (!slot) throw notFound()
      await audit({ adminId: actor.adminId, action: 'delivery_slot_status_changed', details: { slotId: id, status: change.status, forced: change.confirmInUse }, ip: actor.ip })
      return slot
    },

    async remove(id: string, actor: Actor): Promise<void> {
      await get(id)
      assertCanDelete(await repository.usage(id), 'delivery slot')
      if (!(await repository.remove(id))) throw notFound()
      await audit({ adminId: actor.adminId, action: 'delivery_slot_deleted', details: { slotId: id }, ip: actor.ip })
    },
  }
}

export type DeliverySlotService = ReturnType<typeof createDeliverySlotService>
