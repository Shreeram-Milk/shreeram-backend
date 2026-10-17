import { addDays, indiaClock } from '../delivery-brain/rules.js'
import type { DashboardData, DashboardRepository } from './repository.js'

/** The landing page's numbers. "Today" is the India calendar day, never the server's own. */
export function createDashboardService({ repository, now = () => new Date() }: { repository: DashboardRepository; now?: () => Date }) {
  return {
    async get(): Promise<DashboardData> {
      const today = indiaClock(now()).date
      const tomorrow = addDays(today, 1)
      return { today, tomorrow, ...(await repository.summary(today, tomorrow)) }
    },
  }
}

export type DashboardService = ReturnType<typeof createDashboardService>
