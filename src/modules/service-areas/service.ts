import { AppError } from '../../http/errors.js'
import { ValidationError } from '../../http/validate.js'
import type { AuditWriter } from '../audit/audit.js'
import { assertCanDeactivate, assertCanDelete, nameTakenError, notFoundError, type PageQuery, type StatusChange, type Usage } from '../master-data/shared.js'
import type { Pin, ServiceArea, ServiceAreaRepository } from './repository.js'
import type { BulkPinInput, PinInput, PinListQuery, ServiceAreaInput } from './schema.js'

type Dependencies = { repository: ServiceAreaRepository; audit: AuditWriter }
type Actor = { adminId: string; ip: string | null }

const notFound = () => notFoundError('SERVICE_AREA_NOT_FOUND', 'service area')
const pinNotFound = () => notFoundError('PIN_NOT_FOUND', 'PIN code')

export function createServiceAreaService({ repository, audit }: Dependencies) {
  async function get(id: string): Promise<ServiceArea> {
    const area = await repository.findById(id)
    if (!area) throw notFound()
    return area
  }

  /** PIN codes only make sense in a PIN-code area. */
  async function getPinArea(id: string): Promise<ServiceArea> {
    const area = await get(id)
    if (area.coverageType !== 'pin_code') throw new AppError(409, 'AREA_NOT_PIN_BASED', 'Only a PIN-code service area has PIN codes.')
    return area
  }

  /** Every slot must exist, and a PIN cannot newly allow an inactive slot (one it already allows may stay). */
  async function checkSlots(slotIds: string[], alreadyAllowed: string[] = []) {
    const statuses = await repository.slotStatuses(slotIds)
    const allowed = new Set(alreadyAllowed)
    for (const slotId of slotIds) {
      const status = statuses.get(slotId)
      if (!status) throw new ValidationError([{ field: 'allowedDeliverySlotIds', message: 'That delivery slot does not exist.' }])
      if (status === 'inactive' && !allowed.has(slotId)) throw new ValidationError([{ field: 'allowedDeliverySlotIds', message: 'Choose an active slot.' }])
    }
  }

  return {
    list: (query: PageQuery) => repository.list(query),
    listAll: () => repository.listAll(),
    get,

    async usage(id: string): Promise<Usage[]> {
      await get(id)
      return repository.usage(id)
    },

    async create(input: ServiceAreaInput, actor: Actor): Promise<ServiceArea> {
      if (await repository.nameExists(input.name)) throw nameTakenError()
      const area = await repository.create(input, actor.adminId)
      await audit({ adminId: actor.adminId, action: 'service_area_created', details: { areaId: area.id }, ip: actor.ip })
      return area
    },

    async update(id: string, input: ServiceAreaInput, actor: Actor): Promise<ServiceArea> {
      const current = await get(id)
      if (await repository.nameExists(input.name, id)) throw nameTakenError()
      if (input.coverageType !== current.coverageType && (await repository.countProductsBrokenBy(id, input.coverageType)) > 0) {
        throw new AppError(409, 'AREA_COVERAGE_IN_USE', 'Products use this delivery area as it is now. Change those products first.')
      }
      // Leaving PIN-code coverage deletes the area's PIN codes, so the admin must say yes to that.
      const removesPins = current.coverageType === 'pin_code' && input.coverageType !== 'pin_code' && current.pinCount > 0
      if (removesPins && !input.confirmRemovePins) {
        throw new AppError(409, 'PIN_REMOVAL_NEEDS_CONFIRMATION', `Changing the coverage type will permanently remove ${current.pinCount} PIN codes and their delivery slots. Confirm to continue.`, { pinCount: current.pinCount })
      }
      if (current.status === 'active' && input.status === 'inactive') assertCanDeactivate(await repository.usage(id), { status: 'inactive', confirmInUse: false }, 'service area')
      const area = await repository.update(id, input, actor.adminId, removesPins)
      if (!area) throw notFound()
      await audit({ adminId: actor.adminId, action: 'service_area_updated', details: { areaId: id, removedPins: removesPins ? current.pinCount : 0 }, ip: actor.ip })
      return area
    },

    async setStatus(id: string, change: StatusChange, actor: Actor): Promise<ServiceArea> {
      await get(id)
      assertCanDeactivate(await repository.usage(id), change, 'service area')
      const area = await repository.setStatus(id, change.status, actor.adminId)
      if (!area) throw notFound()
      await audit({ adminId: actor.adminId, action: 'service_area_status_changed', details: { areaId: id, status: change.status, forced: change.confirmInUse }, ip: actor.ip })
      return area
    },

    async remove(id: string, actor: Actor): Promise<void> {
      await get(id)
      assertCanDelete(await repository.usage(id), 'service area')
      if (!(await repository.remove(id))) throw notFound()
      await audit({ adminId: actor.adminId, action: 'service_area_deleted', details: { areaId: id }, ip: actor.ip })
    },

    async listPins(areaId: string, query: PinListQuery) {
      await get(areaId)
      return repository.listPins(areaId, query)
    },

    async getPin(areaId: string, pinId: string): Promise<Pin> {
      await get(areaId)
      const pin = await repository.findPin(areaId, pinId)
      if (!pin) throw pinNotFound()
      return pin
    },

    async createPin(areaId: string, input: PinInput, actor: Actor): Promise<Pin> {
      await getPinArea(areaId)
      if (await repository.pinExists(areaId, input.pinCode)) throw new AppError(409, 'PIN_EXISTS', 'This PIN code already exists in this service area.')
      await checkSlots(input.allowedDeliverySlotIds)
      const pin = await repository.createPin(areaId, input)
      await audit({ adminId: actor.adminId, action: 'service_area_pin_created', details: { areaId, pinId: pin.id }, ip: actor.ip })
      return pin
    },

    async updatePin(areaId: string, pinId: string, input: PinInput, actor: Actor): Promise<Pin> {
      await getPinArea(areaId)
      const current = await repository.findPin(areaId, pinId)
      if (!current) throw pinNotFound()
      if (await repository.pinExists(areaId, input.pinCode, pinId)) throw new AppError(409, 'PIN_EXISTS', 'This PIN code already exists in this service area.')
      await checkSlots(input.allowedDeliverySlotIds, current.allowedDeliverySlotIds)
      const pin = await repository.updatePin(areaId, pinId, input)
      if (!pin) throw pinNotFound()
      await audit({ adminId: actor.adminId, action: 'service_area_pin_updated', details: { areaId, pinId }, ip: actor.ip })
      return pin
    },

    /** Adds many PIN codes at once with the same slots; PIN codes the area already has are skipped, not changed. */
    async addPins(areaId: string, input: BulkPinInput, actor: Actor): Promise<{ added: string[]; skipped: string[] }> {
      await getPinArea(areaId)
      await checkSlots(input.allowedDeliverySlotIds)
      const entries = input.pinCodes.map(pinCode => ({ pinCode, locality: input.localities[pinCode] ?? input.locality }))
      const added = await repository.addPins(areaId, entries, { allowedDeliverySlotIds: input.allowedDeliverySlotIds, status: input.status })
      await audit({ adminId: actor.adminId, action: 'service_area_pins_added', details: { areaId, added: added.length, skipped: input.pinCodes.length - added.length }, ip: actor.ip })
      const addedSet = new Set(added)
      return { added, skipped: input.pinCodes.filter(code => !addedSet.has(code)) }
    },
  }
}

export type ServiceAreaService = ReturnType<typeof createServiceAreaService>
