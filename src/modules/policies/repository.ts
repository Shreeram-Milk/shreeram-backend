import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import type { PolicyInput, PolicyStatus, PolicyType } from './schema.js'

export type Policy = PolicyInput & { id: string; status: PolicyStatus; publishedAt: string | null; createdAt: string; updatedAt: string }

/** Storage for policy versions. The Postgres version below is the real one; tests use a fake. */
export interface PolicyRepository {
  list(): Promise<Policy[]>
  listPublished(): Promise<Policy[]>
  findById(id: string): Promise<Policy | null>
  findPublished(type: PolicyType): Promise<Policy | null>
  /** Version labels already used for this policy type. */
  versionsOf(type: PolicyType): Promise<string[]>
  create(input: PolicyInput, adminId: string): Promise<Policy>
  /** Changes a draft. Returns null when the version is not a draft (published and archived versions never change). */
  updateDraft(id: string, input: PolicyInput, adminId: string): Promise<Policy | null>
  /** Publishes a draft and archives the previously published version of the same type, as one all-or-nothing step. */
  publish(id: string, type: PolicyType, adminId: string): Promise<Policy | null>
  /** Archives a published version. Returns null when it is not published. */
  archive(id: string, adminId: string): Promise<Policy | null>
  /** Deletes a draft that is no longer wanted. Returns false when it is not a draft; history is never deleted. */
  deleteDraft(id: string): Promise<boolean>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
// The date is read as text so it can never shift a day with the server's timezone.
const COLUMNS = "id, type, version, title_en, title_gu, body_en, body_gu, to_char(effective_date, 'YYYY-MM-DD') as effective_date, status, published_at, created_at, updated_at"
const ORDER = 'order by type, effective_date desc, created_at desc'

const toPolicy = (row: Row): Policy => ({
  id: String(row.id), type: row.type as PolicyType, version: String(row.version), titleEn: String(row.title_en), titleGu: String(row.title_gu), bodyEn: String(row.body_en), bodyGu: String(row.body_gu),
  effectiveDate: String(row.effective_date), status: row.status as PolicyStatus, publishedAt: row.published_at ? iso(row.published_at) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
})

class NotADraft extends Error {}

export function createPolicyRepository(database: Database): PolicyRepository {
  async function findById(id: string): Promise<Policy | null> {
    const { rows } = await database.query<Row>(`select ${COLUMNS} from policy_documents where id = $1`, [id])
    return rows[0] ? toPolicy(rows[0]) : null
  }

  return {
    async list() { return (await database.query<Row>(`select ${COLUMNS} from policy_documents ${ORDER}`)).rows.map(toPolicy) },
    async listPublished() { return (await database.query<Row>(`select ${COLUMNS} from policy_documents where status = 'published' ${ORDER}`)).rows.map(toPolicy) },
    findById,
    async findPublished(type) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from policy_documents where type = $1 and status = 'published'`, [type])
      return rows[0] ? toPolicy(rows[0]) : null
    },
    async versionsOf(type) { return (await database.query<Row>('select version from policy_documents where type = $1', [type])).rows.map(row => String(row.version)) },
    async create(input, adminId) {
      const { rows } = await database.query<Row>(
        'insert into policy_documents (type, version, title_en, title_gu, body_en, body_gu, effective_date, updated_by) values ($1, $2, $3, $4, $5, $6, $7::date, $8) returning id',
        [input.type, input.version, input.titleEn, input.titleGu, input.bodyEn, input.bodyGu, input.effectiveDate, adminId],
      )
      return (await findById(String((rows[0] as Row).id))) as Policy
    },
    async updateDraft(id, input, adminId) {
      const { rows } = await database.query<Row>(
        "update policy_documents set type = $2, version = $3, title_en = $4, title_gu = $5, body_en = $6, body_gu = $7, effective_date = $8::date, updated_at = now(), updated_by = $9 where id = $1 and status = 'draft' returning id",
        [id, input.type, input.version, input.titleEn, input.titleGu, input.bodyEn, input.bodyGu, input.effectiveDate, adminId],
      )
      return rows[0] ? findById(id) : null
    },
    async publish(id, type, adminId) {
      try {
        await withTransaction(database, async client => {
          await client.query("update policy_documents set status = 'archived', updated_at = now(), updated_by = $2 where type = $1 and status = 'published'", [type, adminId])
          const { rows } = await client.query("update policy_documents set status = 'published', published_at = now(), updated_at = now(), updated_by = $2 where id = $1 and status = 'draft' returning id", [id, adminId])
          // Nothing to publish: undo the archiving too, so the live version is never lost.
          if (!rows[0]) throw new NotADraft()
        })
      } catch (error) {
        if (error instanceof NotADraft) return null
        throw error
      }
      return findById(id)
    },
    async archive(id, adminId) {
      const { rows } = await database.query<Row>("update policy_documents set status = 'archived', updated_at = now(), updated_by = $2 where id = $1 and status = 'published' returning id", [id, adminId])
      return rows[0] ? findById(id) : null
    },
    async deleteDraft(id) {
      const { rows } = await database.query<Row>("delete from policy_documents where id = $1 and status = 'draft' returning id", [id])
      return rows.length > 0
    },
  }
}
