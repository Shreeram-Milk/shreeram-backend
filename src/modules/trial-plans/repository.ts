import type { Database } from '../../db/pool.js'
import type { RecordStatus } from '../master-data/shared.js'
import { createPgSimpleRepository } from '../master-data/simple-records-pg.js'
import type { SimpleRecordRepository } from '../master-data/simple-records.js'
import type { TrialPlanInput } from './schema.js'

export type TrialPlan = TrialPlanInput & { id: string; updatedAt: string }
export type TrialPlanRepository = SimpleRecordRepository<TrialPlan, TrialPlanInput>

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

export function createTrialPlanRepository(database: Database): TrialPlanRepository {
  return createPgSimpleRepository<TrialPlan, TrialPlanInput>(database, {
    table: 'trial_plans',
    select: 'id, name, description, duration_days, status, updated_at',
    orderBy: 'duration_days, name',
    productUsageSql: "select count(*)::int as total, coalesce((array_agg(p.name order by p.name))[1:5], '{}') as names from product_trial_plans l join products p on p.id = l.product_id where l.trial_plan_id = $1",
    map: row => ({ id: String(row.id), name: String(row.name), description: String(row.description), durationDays: Number(row.duration_days), status: row.status as RecordStatus, updatedAt: iso(row.updated_at) }),
    writable: [
      { column: 'name', value: input => input.name },
      { column: 'description', value: input => input.description },
      { column: 'duration_days', value: input => input.durationDays },
      { column: 'status', value: input => input.status },
    ],
  })
}
