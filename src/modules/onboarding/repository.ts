import type { Database } from '../../db/pool.js'
import type { SlideInput, SlideStatus } from './schema.js'

/** `imageKey` is where the picture sits in storage; it never leaves the backend. */
export type Slide = SlideInput & { id: string; imageKey: string | null; sortOrder: number; createdAt: string; updatedAt: string }

/** Storage for introduction slides. The Postgres version below is the real one; tests use a fake. */
export interface OnboardingRepository {
  list(): Promise<Slide[]>
  listActive(): Promise<Slide[]>
  findById(id: string): Promise<Slide | null>
  create(input: SlideInput, sortOrder: number): Promise<Slide>
  update(id: string, input: SlideInput): Promise<Slide | null>
  setStatus(id: string, status: SlideStatus): Promise<Slide | null>
  countActive(excludingId?: string): Promise<number>
  nextSortOrder(): Promise<number>
  /** Numbers the slides 1, 2, 3... in the order given, in one step. */
  setOrder(ids: string[]): Promise<void>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const COLUMNS = 's.id, s.image_asset_id, m.object_key as image_key, s.title_en, s.title_gu, s.description_en, s.description_gu, s.sort_order, s.status, s.created_at, s.updated_at'
// Only a finished upload counts as a picture.
const FROM = "onboarding_slides s left join media_assets m on m.id = s.image_asset_id and m.status = 'ready'"
const ORDER = 'order by s.sort_order, s.created_at'

const toSlide = (row: Row): Slide => ({
  id: String(row.id), imageAssetId: String(row.image_asset_id), imageKey: row.image_key ? String(row.image_key) : null, titleEn: String(row.title_en), titleGu: String(row.title_gu),
  descriptionEn: String(row.description_en), descriptionGu: String(row.description_gu), sortOrder: Number(row.sort_order), status: row.status as SlideStatus, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
})

export function createOnboardingRepository(database: Database): OnboardingRepository {
  async function findById(id: string): Promise<Slide | null> {
    const { rows } = await database.query<Row>(`select ${COLUMNS} from ${FROM} where s.id = $1`, [id])
    return rows[0] ? toSlide(rows[0]) : null
  }

  return {
    async list() { return (await database.query<Row>(`select ${COLUMNS} from ${FROM} ${ORDER}`)).rows.map(toSlide) },
    async listActive() { return (await database.query<Row>(`select ${COLUMNS} from ${FROM} where s.status = 'active' ${ORDER}`)).rows.map(toSlide) },
    findById,
    async create(input, sortOrder) {
      const { rows } = await database.query<Row>(
        'insert into onboarding_slides (image_asset_id, title_en, title_gu, description_en, description_gu, sort_order, status) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [input.imageAssetId, input.titleEn, input.titleGu, input.descriptionEn, input.descriptionGu, sortOrder, input.status],
      )
      return (await findById(String((rows[0] as Row).id))) as Slide
    },
    async update(id, input) {
      const { rows } = await database.query<Row>(
        'update onboarding_slides set image_asset_id = $2, title_en = $3, title_gu = $4, description_en = $5, description_gu = $6, status = $7, updated_at = now() where id = $1 returning id',
        [id, input.imageAssetId, input.titleEn, input.titleGu, input.descriptionEn, input.descriptionGu, input.status],
      )
      return rows[0] ? findById(id) : null
    },
    async setStatus(id, status) {
      const { rows } = await database.query<Row>('update onboarding_slides set status = $2, updated_at = now() where id = $1 returning id', [id, status])
      return rows[0] ? findById(id) : null
    },
    async countActive(excludingId) {
      const { rows } = await database.query<Row>("select count(*)::int as total from onboarding_slides where status = 'active' and ($1::uuid is null or id <> $1::uuid)", [excludingId ?? null])
      return Number((rows[0] as Row).total)
    },
    async nextSortOrder() {
      const { rows } = await database.query<Row>('select coalesce(max(sort_order), 0)::int + 1 as next from onboarding_slides')
      return Number((rows[0] as Row).next)
    },
    async setOrder(ids) {
      await database.query('update onboarding_slides s set sort_order = v.position, updated_at = now() from unnest($1::uuid[]) with ordinality as v(id, position) where s.id = v.id and s.sort_order <> v.position', [ids])
    },
  }
}
