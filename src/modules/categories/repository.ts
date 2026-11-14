import type { Database } from '../../db/pool.js'
import type { ObjectStorage } from '../../integrations/storage/storage.js'
import type { RecordStatus } from '../master-data/shared.js'
import { createPgSimpleRepository } from '../master-data/simple-records-pg.js'
import type { SimpleRecordRepository } from '../master-data/simple-records.js'
import type { CategoryInput } from './schema.js'

/** A category as the admin and the app see it: its tile picture as a short-lived link (null without one). */
export type Category = CategoryInput & { id: string; updatedAt: string; imageUrl: string | null }
export type CategoryRepository = SimpleRecordRepository<Category, CategoryInput>
/** As stored: the picture's storage key, turned into a link before it leaves the repository. */
type StoredCategory = CategoryInput & { id: string; updatedAt: string; imageKey: string | null }

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))

export function createCategoryRepository(database: Database, storage?: Pick<ObjectStorage, 'createDownloadUrl'>): CategoryRepository {
  const base = createPgSimpleRepository<StoredCategory, CategoryInput>(database, {
    table: 'categories',
    // Only a picture that finished uploading is shown.
    select: "id, name, name_gu, description, sort_order, status, updated_at, image_asset_id, (select m.object_key from media_assets m where m.id = categories.image_asset_id and m.status = 'ready') as image_key",
    orderBy: 'sort_order, name',
    productUsageSql: "select count(*)::int as total, coalesce((array_agg(name order by name))[1:5], '{}') as names from products where category_id = $1",
    map: row => ({
      id: String(row.id), name: String(row.name), nameGu: String(row.name_gu), description: String(row.description), sortOrder: Number(row.sort_order), status: row.status as RecordStatus,
      updatedAt: iso(row.updated_at), imageAssetId: row.image_asset_id ? String(row.image_asset_id) : null, imageKey: row.image_key ? String(row.image_key) : null,
    }),
    writable: [
      { column: 'name', value: input => input.name },
      { column: 'name_gu', value: input => input.nameGu },
      { column: 'description', value: input => input.description },
      { column: 'sort_order', value: input => input.sortOrder },
      { column: 'status', value: input => input.status },
      { column: 'image_asset_id', value: input => input.imageAssetId },
    ],
  })

  // A link that cannot be made (storage not set up) shows the plain tile rather than failing the whole list.
  const withLink = async ({ imageKey, ...category }: StoredCategory): Promise<Category> => ({
    ...category, imageUrl: imageKey && storage ? await storage.createDownloadUrl(imageKey).catch(() => null) : null,
  })
  const maybe = async (row: StoredCategory | null) => (row ? withLink(row) : null)

  return {
    async list(query) { const result = await base.list(query); return { ...result, rows: await Promise.all(result.rows.map(withLink)) } },
    async listAll() { return Promise.all((await base.listAll()).map(withLink)) },
    findById: async id => maybe(await base.findById(id)),
    create: async (input, adminId) => withLink(await base.create(input, adminId)),
    update: async (id, input, adminId) => maybe(await base.update(id, input, adminId)),
    setStatus: async (id, status, adminId) => maybe(await base.setStatus(id, status, adminId)),
    nameExists: (name, excludingId) => base.nameExists(name, excludingId),
    usage: id => base.usage(id),
    remove: id => base.remove(id),
  }
}
