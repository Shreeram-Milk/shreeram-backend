import type { Database } from '../../db/pool.js'
import type { RecordStatus } from '../master-data/shared.js'
import { createPgSimpleRepository } from '../master-data/simple-records-pg.js'
import type { SimpleRecordRepository } from '../master-data/simple-records.js'
import type { SubscriptionRuleInput, SubscriptionType } from './schema.js'

export type SubscriptionRule = SubscriptionRuleInput & { id: string; updatedAt: string }
export type SubscriptionRuleRepository = SimpleRecordRepository<SubscriptionRule, SubscriptionRuleInput>

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

export function createSubscriptionRuleRepository(database: Database): SubscriptionRuleRepository {
  return createPgSimpleRepository<SubscriptionRule, SubscriptionRuleInput>(database, {
    table: 'subscription_rules',
    select: 'id, name, description, system_type, length_options, min_days, max_days, status, updated_at',
    orderBy: 'name',
    productUsageSql: "select count(*)::int as total, coalesce((array_agg(p.name order by p.name))[1:5], '{}') as names from product_subscription_rules l join products p on p.id = l.product_id where l.subscription_rule_id = $1",
    map: row => ({ id: String(row.id), name: String(row.name), description: String(row.description), systemType: row.system_type as SubscriptionType, lengthOptions: ((row.length_options as number[] | null) ?? []).map(Number), minDays: Number(row.min_days), maxDays: Number(row.max_days), status: row.status as RecordStatus, updatedAt: iso(row.updated_at) }),
    writable: [
      { column: 'name', value: input => input.name },
      { column: 'description', value: input => input.description },
      { column: 'system_type', value: input => input.systemType },
      { column: 'length_options', value: input => input.lengthOptions },
      { column: 'min_days', value: input => input.minDays },
      { column: 'max_days', value: input => input.maxDays },
      { column: 'status', value: input => input.status },
    ],
  })
}
