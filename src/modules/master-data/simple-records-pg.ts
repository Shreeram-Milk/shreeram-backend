import type { Database } from '../../db/pool.js'
import type { SimpleRecordRepository } from './simple-records.js'
import { guardDelete, guardUnique, likePattern, type RecordStatus } from './shared.js'

type Row = Record<string, unknown>

/** The only tables this helper may touch. Names are fixed in code, never taken from a request. */
type SimpleTable = 'categories' | 'trial_plans' | 'subscription_rules'

type Config<Saved, Input> = {
  table: SimpleTable
  /** Columns to read, such as `id, name, status, updated_at`. */
  select: string
  orderBy: string
  map: (row: Row) => Saved
  /** The columns an admin may write, with where each value comes from. Anything not listed can never be written. */
  writable: Array<{ column: string; value: (input: Input) => unknown }>
  /** Fixed SQL (never built from a request) that counts the products using one record: `$1` is the record id; returns `total` and `names`. */
  productUsageSql: string
}

/** The Postgres storage shared by the plain named records. Their usage is the products that use them. */
export function createPgSimpleRepository<Saved extends { id: string; status: RecordStatus }, Input extends { name: string; status: RecordStatus }>(database: Database, config: Config<Saved, Input>): SimpleRecordRepository<Saved, Input> {
  const { table, select, orderBy, map, writable, productUsageSql } = config

  async function findById(id: string): Promise<Saved | null> {
    const { rows } = await database.query<Row>(`select ${select} from ${table} where id = $1`, [id])
    return rows[0] ? map(rows[0]) : null
  }

  return {
    async list({ search, status, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${select}, count(*) over() as total from ${table}
          where ($1::text is null or status = $1) and ($2::text is null or name ilike $2)
          order by ${orderBy} limit $3 offset $4`,
        [status ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(map), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    async listAll() { return (await database.query<Row>(`select ${select} from ${table} order by ${orderBy}`)).rows.map(map) },
    findById,
    create: (input, adminId) => guardUnique(async () => {
      const columns = [...writable.map(field => field.column), 'updated_by']
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
      const { rows } = await database.query<Row>(`insert into ${table} (${columns.join(', ')}) values (${placeholders}) returning id`, [...writable.map(field => field.value(input)), adminId])
      return (await findById(String((rows[0] as Row).id))) as Saved
    }),
    update: (id, input, adminId) => guardUnique(async () => {
      const assignments = writable.map((field, index) => `${field.column} = $${index + 2}`).join(', ')
      const { rows } = await database.query<Row>(
        `update ${table} set ${assignments}, updated_at = now(), updated_by = $${writable.length + 2} where id = $1 returning id`,
        [id, ...writable.map(field => field.value(input)), adminId],
      )
      return rows[0] ? findById(id) : null
    }),
    async setStatus(id, status, adminId) {
      const { rows } = await database.query<Row>(`update ${table} set status = $2, updated_at = now(), updated_by = $3 where id = $1 returning id`, [id, status, adminId])
      return rows[0] ? findById(id) : null
    },
    remove: id => guardDelete(async () => (await database.query<Row>(`delete from ${table} where id = $1 returning id`, [id])).rows.length > 0, 'record'),
    async nameExists(name, excludingId) {
      const { rows } = await database.query<Row>(`select 1 from ${table} where lower(trim(name)) = lower(trim($1)) and ($2::uuid is null or id <> $2::uuid) limit 1`, [name, excludingId ?? null])
      return rows.length > 0
    },
    async usage(id) {
      const { rows } = await database.query<Row>(productUsageSql, [id])
      const row = rows[0] as Row
      return [{ label: 'products', count: Number(row.total), examples: (row.names as string[]) ?? [] }]
    },
  }
}
