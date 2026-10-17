import type { Database } from '../../db/pool.js'
import type { RecordStatus } from '../master-data/shared.js'
import { createPgSimpleRepository } from '../master-data/simple-records-pg.js'
import type { SimpleRecordRepository } from '../master-data/simple-records.js'
import type { CategoryInput } from './schema.js'

export type Category = CategoryInput & { id: string; updatedAt: string }
export type CategoryRepository = SimpleRecordRepository<Category, CategoryInput>

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

export function createCategoryRepository(database: Database): CategoryRepository {
  return createPgSimpleRepository<Category, CategoryInput>(database, {
    table: 'categories',
    select: 'id, name, name_gu, description, sort_order, status, updated_at',
    orderBy: 'sort_order, name',
    productUsageSql: "select count(*)::int as total, coalesce((array_agg(name order by name))[1:5], '{}') as names from products where category_id = $1",
    map: row => ({ id: String(row.id), name: String(row.name), nameGu: String(row.name_gu), description: String(row.description), sortOrder: Number(row.sort_order), status: row.status as RecordStatus, updatedAt: iso(row.updated_at) }),
    writable: [
      { column: 'name', value: input => input.name },
      { column: 'name_gu', value: input => input.nameGu },
      { column: 'description', value: input => input.description },
      { column: 'sort_order', value: input => input.sortOrder },
      { column: 'status', value: input => input.status },
    ],
  })
}
