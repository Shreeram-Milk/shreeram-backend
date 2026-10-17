import type { Database } from '../../db/pool.js'
import { websiteHomeSchema, type WebsiteHomeInput } from './schema.js'

export type StoredWebsiteHome = WebsiteHomeInput & { updatedAt: string }

/** Storage for the one website Home page record. The Postgres version below is the real one; tests use a fake. */
export interface WebsiteHomeRepository {
  get(): Promise<StoredWebsiteHome>
  save(input: WebsiteHomeInput, adminId: string): Promise<StoredWebsiteHome>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

// The stored JSON is read back through the same rules it was saved with, so an old or hand-edited row can never reach the website malformed.
const toHome = (row: Row): StoredWebsiteHome => ({ ...websiteHomeSchema.parse(row.content), updatedAt: iso(row.updated_at) })

export function createWebsiteHomeRepository(database: Database): WebsiteHomeRepository {
  return {
    async get() {
      const { rows } = await database.query<Row>('select content, updated_at from website_home where id')
      // The starting row is created by the migration. If it is missing, say so plainly instead of guessing.
      if (!rows[0]) throw new Error('The website_home row is missing. Run migration 0026_website_home.sql.')
      return toHome(rows[0])
    },
    async save(input, adminId) {
      const { rows } = await database.query<Row>(
        'update website_home set content = $1::jsonb, updated_at = now(), updated_by = $2 where id returning content, updated_at',
        [JSON.stringify(input), adminId],
      )
      if (!rows[0]) throw new Error('The website_home row is missing. Run migration 0026_website_home.sql.')
      return toHome(rows[0])
    },
  }
}
