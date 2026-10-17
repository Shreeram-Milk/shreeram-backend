import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import { noopNotifier, type Notifier } from '../notifications/notifier.js'
import { formatRupees } from '../notifications/rules.js'
import type { Adjustment, AdjustmentRepository } from './repository.js'
import type { AdjustmentListQuery, ApplyAdjustment, NewAdjustment } from './schema.js'

type Dependencies = { repository: AdjustmentRepository; audit: AuditWriter; notifier?: Notifier; now?: () => Date }
type Actor = { adminId: string; ip: string | null }

const notFound = () => new AppError(404, 'ADJUSTMENT_NOT_FOUND', 'That adjustment does not exist.')

export function createAdjustmentService({ repository, audit, notifier = noopNotifier, now = () => new Date() }: Dependencies) {
  return {
    list: (query: AdjustmentListQuery) => repository.list(query),

    async create(input: NewAdjustment, actor: Actor): Promise<Adjustment> {
      const created = await repository.create(input, actor.adminId, now())
      if (!created) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'That customer does not exist.')
      await audit({ adminId: actor.adminId, action: 'prepaid_adjustment_created', details: { adjustmentId: created.id, type: input.type, amountPaise: input.amountPaise }, ip: actor.ip })
      return created
    },

    async apply(id: string, input: ApplyAdjustment, actor: Actor): Promise<Adjustment> {
      const applied = await repository.apply(id, input, actor.adminId)
      if (!applied) throw notFound()
      await audit({ adminId: actor.adminId, action: 'prepaid_adjustment_applied', details: { adjustmentId: id, providerReference: input.providerReference }, ip: actor.ip })
      // Only a refund is news to the customer; a carried-forward delivery or a manual correction is not.
      if (applied.type === 'refund_pending' && applied.amountPaise) {
        await notifier.notify({ event: 'refund_sent', customerId: applied.customerId, vars: { amount: formatRupees(applied.amountPaise), order: applied.orderNumber ?? '' }, link: null, dedupeKey: `refund:${id}` })
      }
      return applied
    },

    async cancel(id: string, actor: Actor): Promise<Adjustment> {
      const cancelled = await repository.cancel(id)
      if (!cancelled) throw new AppError(404, 'ADJUSTMENT_NOT_PENDING', 'That adjustment is not pending.')
      await audit({ adminId: actor.adminId, action: 'prepaid_adjustment_cancelled', details: { adjustmentId: id }, ip: actor.ip })
      return cancelled
    },
  }
}

export type AdjustmentService = ReturnType<typeof createAdjustmentService>
