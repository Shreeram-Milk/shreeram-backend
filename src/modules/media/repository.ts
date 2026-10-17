import type { Database } from '../../db/pool.js'
import type { ImageType, MediaPurpose } from './schema.js'

export type MediaAsset = { id: string; objectKey: string; purpose: MediaPurpose; contentType: ImageType; sizeBytes: number; status: 'pending' | 'ready' }
export type NewMediaAsset = Omit<MediaAsset, 'id' | 'status'> & { uploadedBy: string }

/** Storage for the records of uploaded files. The Postgres version below is the real one; tests use a fake. */
export interface MediaRepository {
  createPending(asset: NewMediaAsset): Promise<MediaAsset>
  findById(id: string): Promise<MediaAsset | null>
  markReady(id: string): Promise<void>
}

type Row = Record<string, unknown>
const COLUMNS = 'id, object_key, purpose, content_type, size_bytes, status'
const toAsset = (row: Row): MediaAsset => ({ id: String(row.id), objectKey: String(row.object_key), purpose: row.purpose as MediaPurpose, contentType: row.content_type as ImageType, sizeBytes: Number(row.size_bytes), status: row.status as MediaAsset['status'] })

export function createMediaRepository(database: Database): MediaRepository {
  return {
    async createPending(asset) {
      const { rows } = await database.query<Row>(
        `insert into media_assets (object_key, purpose, content_type, size_bytes, uploaded_by) values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
        [asset.objectKey, asset.purpose, asset.contentType, asset.sizeBytes, asset.uploadedBy],
      )
      return toAsset(rows[0] as Row)
    },
    async findById(id) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from media_assets where id = $1`, [id])
      return rows[0] ? toAsset(rows[0]) : null
    },
    async markReady(id) {
      await database.query(`update media_assets set status = 'ready', ready_at = now() where id = $1`, [id])
    },
  }
}
