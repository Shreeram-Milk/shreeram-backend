import type { Database } from '../../db/pool.js'
import type { BannerInput, BannerStatus } from './schema.js'

/** `imageKey` is where the picture sits in storage; it never leaves the backend. The service turns it into a short-lived link. */
export type Banner = BannerInput & { id: string; imageKey: string | null; createdAt: string; updatedAt: string }

/** Storage for banners. The Postgres version below is the real one; tests use a fake. */
export interface BannerRepository {
  list(): Promise<Banner[]>
  findById(id: string): Promise<Banner | null>
  create(input: BannerInput): Promise<Banner>
  update(id: string, input: BannerInput): Promise<Banner | null>
  setStatus(id: string, status: BannerStatus): Promise<Banner | null>
  /** Active banners whose dates include `businessDate`, for the customer app. */
  listPublic(businessDate: string): Promise<Banner[]>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
// `date` columns come back as JS dates at local midnight; format them from their own parts so the day never shifts.
const day = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  return String(value).slice(0, 10)
}

const COLUMNS = 'b.id, b.type, b.audience, b.title_en, b.title_gu, b.message_en, b.message_gu, b.label_en, b.label_gu, b.image_asset_id, m.object_key as image_key, b.cta_type, b.cta_target, b.start_date, b.end_date, b.sort_order, b.status, b.created_at, b.updated_at'
// Only a finished upload counts as a picture.
const FROM = "banners b left join media_assets m on m.id = b.image_asset_id and m.status = 'ready'"

function toBanner(row: Row): Banner {
  return {
    id: String(row.id), type: row.type as Banner['type'], audience: row.audience as Banner['audience'], titleEn: String(row.title_en), titleGu: String(row.title_gu),
    messageEn: String(row.message_en), messageGu: String(row.message_gu), labelEn: String(row.label_en), labelGu: String(row.label_gu), imageAssetId: row.image_asset_id ? String(row.image_asset_id) : null, imageKey: row.image_key ? String(row.image_key) : null, ctaType: row.cta_type as Banner['ctaType'], ctaTarget: String(row.cta_target),
    startDate: day(row.start_date), endDate: day(row.end_date), sortOrder: Number(row.sort_order), status: row.status as Banner['status'], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  }
}

const values = (input: BannerInput) => [input.type, input.audience, input.titleEn, input.titleGu, input.messageEn, input.messageGu, input.labelEn, input.labelGu, input.imageAssetId, input.ctaType, input.ctaTarget, input.startDate, input.endDate, input.sortOrder, input.status]

export function createBannerRepository(database: Database): BannerRepository {
  async function findById(id: string): Promise<Banner | null> {
    const { rows } = await database.query<Row>(`select ${COLUMNS} from ${FROM} where b.id = $1`, [id])
    return rows[0] ? toBanner(rows[0]) : null
  }

  return {
    async list() {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from ${FROM} order by b.sort_order, b.created_at`)
      return rows.map(toBanner)
    },
    findById,
    async create(input) {
      const { rows } = await database.query<Row>(
        `insert into banners (type, audience, title_en, title_gu, message_en, message_gu, label_en, label_gu, image_asset_id, cta_type, cta_target, start_date, end_date, sort_order, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
        values(input),
      )
      return (await findById(String((rows[0] as Row).id))) as Banner
    },
    async update(id, input) {
      const { rows } = await database.query<Row>(
        `update banners set type = $2, audience = $3, title_en = $4, title_gu = $5, message_en = $6, message_gu = $7, label_en = $8, label_gu = $9, image_asset_id = $10, cta_type = $11, cta_target = $12,
           start_date = $13, end_date = $14, sort_order = $15, status = $16, updated_at = now() where id = $1 returning id`,
        [id, ...values(input)],
      )
      return rows[0] ? findById(id) : null
    },
    async setStatus(id, status) {
      const { rows } = await database.query<Row>(`update banners set status = $2, updated_at = now() where id = $1 returning id`, [id, status])
      return rows[0] ? findById(id) : null
    },
    async listPublic(businessDate) {
      const { rows } = await database.query<Row>(
        `select ${COLUMNS} from ${FROM} where b.status = 'active' and b.audience = 'all_users'
           and (b.start_date is null or b.start_date <= $1::date) and (b.end_date is null or b.end_date >= $1::date) order by b.sort_order, b.created_at`,
        [businessDate],
      )
      return rows.map(toBanner)
    },
  }
}
