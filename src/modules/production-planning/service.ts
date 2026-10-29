import { addDays, indiaClock } from '../delivery-brain/rules.js'
import { AppError } from '../../http/errors.js'
import type { ProductionPlanRepository } from './repository.js'
import { buildRiderSheet, type RiderSheet } from './rider-sheet.js'
import { buildProductionPlan, type PlanWarning, type ProductionPlan } from './rules.js'

/** How old the last delivery-job pass may be before the plan says the subscription numbers may be out of date. */
export const JOB_STALE_MINUTES = 15

type JobStatus = { at: string; failures: number } | null
type Dependencies = {
  repository: ProductionPlanRepository
  now?: () => Date
  /** How many days ahead subscription orders are made. Plans further out are missing subscriptions. */
  horizonDays?: number
  /** When the subscription delivery job last finished a pass. Left out, the plan does not check it. */
  jobStatus?: () => JobStatus
}

/** The warnings that apply to a plan for `date`, read at `now`. Pure, so it is easy to test. */
export function planWarnings(date: string, now: Date, horizonDays: number, job: JobStatus | undefined): PlanWarning[] {
  const warnings: PlanWarning[] = []
  const today = indiaClock(now).date
  if (date > addDays(today, horizonDays)) {
    warnings.push({ code: 'SUBSCRIPTIONS_NOT_READY', message: `Subscription deliveries for this day are not created yet (they appear ${horizonDays} days ahead), so the amounts below are missing every subscription. Do not produce from this.` })
  }
  if (job !== undefined && date <= addDays(today, horizonDays)) {
    const minutes = job ? (now.getTime() - Date.parse(job.at)) / 60_000 : Number.POSITIVE_INFINITY
    if (!job || minutes > JOB_STALE_MINUTES) {
      warnings.push({ code: 'SUBSCRIPTION_JOB_STALE', message: job ? `The job that creates subscription orders last ran ${Math.round(minutes)} minutes ago. Subscription amounts may be missing.` : 'The job that creates subscription orders has not run yet since the server started. Subscription amounts may be missing.' })
    } else if (job.failures > 0) {
      warnings.push({ code: 'SUBSCRIPTION_JOB_FAILING', message: `The job that creates subscription orders failed for ${job.failures} subscription${job.failures === 1 ? '' : 's'} in its last run. Some subscription amounts may be missing.` })
    }
  }
  return warnings
}

export function createProductionPlanService({ repository, now = () => new Date(), horizonDays = 3, jobStatus }: Dependencies) {
  return {
    /** How much to make for a delivery day, per delivery window. Fresh every time: it changes as orders arrive. */
    async planFor(date: string): Promise<ProductionPlan> {
      const { rows, closings } = await repository.demandFor(date)
      const instant = now()
      const plan = buildProductionPlan(date, rows, closings, instant)
      return { ...plan, warnings: planWarnings(date, instant, horizonDays, jobStatus?.()) }
    },

    /** Who gets what in one delivery window, by PIN code, for the riders. Fresh every time, with the same warnings as the plan. */
    async riderSheetFor(date: string, slotId: string): Promise<RiderSheet> {
      const { slot, stops, closing, truncated } = await repository.riderStopsFor(date, slotId)
      if (!slot) throw new AppError(404, 'SLOT_NOT_FOUND', 'That delivery window does not exist.')
      const instant = now()
      return buildRiderSheet({ date, slot, stops, closing, truncated, warnings: planWarnings(date, instant, horizonDays, jobStatus?.()), now: instant })
    },
  }
}

export type ProductionPlanService = ReturnType<typeof createProductionPlanService>
