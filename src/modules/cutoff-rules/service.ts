import { ValidationError } from '../../http/validate.js'
import type { AuditWriter } from '../audit/audit.js'
import { assertCanDeactivate, assertCanDelete, nameTakenError, notFoundError, type PageQuery, type StatusChange, type Usage } from '../master-data/shared.js'
import type { CutoffRule, CutoffRuleRepository } from './repository.js'
import type { CutoffRuleInput } from './schema.js'

type Dependencies = { repository: CutoffRuleRepository; audit: AuditWriter }
type Actor = { adminId: string; ip: string | null }

const notFound = () => notFoundError('CUTOFF_RULE_NOT_FOUND', 'cut-off rule')

export function createCutoffRuleService({ repository, audit }: Dependencies) {
  async function get(id: string): Promise<CutoffRule> {
    const rule = await repository.findById(id)
    if (!rule) throw notFound()
    return rule
  }

  /** Every slot must exist, and a new condition cannot use an inactive slot (one already in the rule may stay). */
  async function checkSlots(input: CutoffRuleInput, current?: CutoffRule) {
    const statuses = await repository.slotStatuses(input.conditions.map(condition => condition.deliverySlotId))
    const alreadyUsed = new Set(current?.conditions.map(condition => condition.deliverySlotId))
    input.conditions.forEach((condition, index) => {
      const status = statuses.get(condition.deliverySlotId)
      const field = `conditions.${index}.deliverySlotId`
      if (!status) throw new ValidationError([{ field, message: 'That delivery slot does not exist.' }])
      if (status === 'inactive' && !alreadyUsed.has(condition.deliverySlotId)) throw new ValidationError([{ field, message: 'Choose an active slot.' }])
    })
  }

  return {
    list: (query: PageQuery) => repository.list(query),
    listAll: () => repository.listAll(),
    get,

    async usage(id: string): Promise<Usage[]> {
      await get(id)
      return repository.usage(id)
    },

    async create(input: CutoffRuleInput, actor: Actor): Promise<CutoffRule> {
      if (await repository.nameExists(input.name)) throw nameTakenError()
      await checkSlots(input)
      const rule = await repository.create(input, actor.adminId)
      await audit({ adminId: actor.adminId, action: 'cutoff_rule_created', details: { ruleId: rule.id }, ip: actor.ip })
      return rule
    },

    async update(id: string, input: CutoffRuleInput, actor: Actor): Promise<CutoffRule> {
      const current = await get(id)
      if (await repository.nameExists(input.name, id)) throw nameTakenError()
      await checkSlots(input, current)
      if (current.status === 'active' && input.status === 'inactive') assertCanDeactivate(await repository.usage(id), { status: 'inactive', confirmInUse: false }, 'cut-off rule')
      const rule = await repository.update(id, input, actor.adminId)
      if (!rule) throw notFound()
      await audit({ adminId: actor.adminId, action: 'cutoff_rule_updated', details: { ruleId: id }, ip: actor.ip })
      return rule
    },

    async setStatus(id: string, change: StatusChange, actor: Actor): Promise<CutoffRule> {
      await get(id)
      assertCanDeactivate(await repository.usage(id), change, 'cut-off rule')
      const rule = await repository.setStatus(id, change.status, actor.adminId)
      if (!rule) throw notFound()
      await audit({ adminId: actor.adminId, action: 'cutoff_rule_status_changed', details: { ruleId: id, status: change.status, forced: change.confirmInUse }, ip: actor.ip })
      return rule
    },

    async remove(id: string, actor: Actor): Promise<void> {
      await get(id)
      assertCanDelete(await repository.usage(id), 'cut-off rule')
      if (!(await repository.remove(id))) throw notFound()
      await audit({ adminId: actor.adminId, action: 'cutoff_rule_deleted', details: { ruleId: id }, ip: actor.ip })
    },
  }
}

export type CutoffRuleService = ReturnType<typeof createCutoffRuleService>
