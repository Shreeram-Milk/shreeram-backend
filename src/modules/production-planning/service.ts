import type { ProductionPlanRepository } from './repository.js'
import { buildProductionPlan, type ProductionPlan } from './rules.js'

type Dependencies = { repository: ProductionPlanRepository; now?: () => Date }

export function createProductionPlanService({ repository, now = () => new Date() }: Dependencies) {
  return {
    /** How much to make for a delivery day, per delivery window. Fresh every time: it changes as orders arrive. */
    async planFor(date: string): Promise<ProductionPlan> {
      const { rows, closings } = await repository.demandFor(date)
      return buildProductionPlan(date, rows, closings, now())
    },
  }
}

export type ProductionPlanService = ReturnType<typeof createProductionPlanService>
