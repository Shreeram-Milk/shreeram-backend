import type { Database } from '../../db/pool.js'
import type { FaqInput, FaqListQuery, FaqStatus } from './schema.js'

export type Faq = FaqInput & { id: string; updatedAt: string }
export type HelpTopic = { id: string; labelEn: string; labelGu: string; iconKey: string; sortOrder: number }

/** Storage for help questions and topics. The Postgres version below is the real one; tests use a fake. */
export interface HelpRepository {
  listTopics(): Promise<HelpTopic[]>
  list(query: FaqListQuery): Promise<{ rows: Faq[]; total: number }>
  listPublished(): Promise<Faq[]>
  findById(id: string): Promise<Faq | null>
  create(input: FaqInput, adminId: string): Promise<Faq>
  update(id: string, input: FaqInput, adminId: string): Promise<Faq | null>
  /** Sets the status. Leaving "published" also clears "featured", so a hidden question never holds a popular place. */
  setStatus(id: string, status: FaqStatus, adminId: string): Promise<Faq | null>
  countFeatured(excludingId?: string): Promise<number>
  /** True when another question under the same topic has the same English wording (ignoring case). */
  questionExists(topic: string, questionEn: string, excludingId?: string): Promise<boolean>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const COLUMNS = 'f.id, f.topic_id, f.question_en, f.question_gu, f.answer_en, f.answer_gu, f.search_keywords, f.featured, f.sort_order, f.status, f.updated_at'
const FROM = 'faqs f join help_topics t on t.id = f.topic_id'
const ORDER = 'order by t.sort_order, f.sort_order, f.question_en'

const toFaq = (row: Row): Faq => ({
  id: String(row.id), topic: row.topic_id as Faq['topic'], questionEn: String(row.question_en), questionGu: String(row.question_gu), answerEn: String(row.answer_en), answerGu: String(row.answer_gu),
  searchKeywords: (row.search_keywords as string[] | null) ?? [], featured: Boolean(row.featured), sortOrder: Number(row.sort_order), status: row.status as FaqStatus, updatedAt: iso(row.updated_at),
})
/** Makes `%`, `_` and `\` in what staff typed match literally in a LIKE search. */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, character => `\\${character}`)}%`

export function createHelpRepository(database: Database): HelpRepository {
  async function findById(id: string): Promise<Faq | null> {
    const { rows } = await database.query<Row>(`select ${COLUMNS} from ${FROM} where f.id = $1`, [id])
    return rows[0] ? toFaq(rows[0]) : null
  }

  return {
    async listTopics() {
      const { rows } = await database.query<Row>('select id, label_en, label_gu, icon_key, sort_order from help_topics order by sort_order')
      return rows.map(row => ({ id: String(row.id), labelEn: String(row.label_en), labelGu: String(row.label_gu), iconKey: String(row.icon_key), sortOrder: Number(row.sort_order) }))
    },
    async list({ search, topic, status, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${COLUMNS}, count(*) over() as total from ${FROM}
          where ($1::text is null or f.topic_id = $1) and ($2::text is null or f.status = $2)
            and ($3::text is null or f.question_en ilike $3 or f.question_gu ilike $3 or f.answer_en ilike $3 or array_to_string(f.search_keywords, ' ') ilike $3)
          ${ORDER} limit $4 offset $5`,
        [topic ?? null, status ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toFaq), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    async listPublished() { return (await database.query<Row>(`select ${COLUMNS} from ${FROM} where f.status = 'published' ${ORDER}`)).rows.map(toFaq) },
    findById,
    async create(input, adminId) {
      const { rows } = await database.query<Row>(
        `insert into faqs (topic_id, question_en, question_gu, answer_en, answer_gu, search_keywords, featured, sort_order, status, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [input.topic, input.questionEn, input.questionGu, input.answerEn, input.answerGu, input.searchKeywords, input.featured, input.sortOrder, input.status, adminId],
      )
      return (await findById(String((rows[0] as Row).id))) as Faq
    },
    async update(id, input, adminId) {
      const { rows } = await database.query<Row>(
        `update faqs set topic_id = $2, question_en = $3, question_gu = $4, answer_en = $5, answer_gu = $6, search_keywords = $7, featured = $8, sort_order = $9, status = $10,
           updated_at = now(), updated_by = $11 where id = $1 returning id`,
        [id, input.topic, input.questionEn, input.questionGu, input.answerEn, input.answerGu, input.searchKeywords, input.featured, input.sortOrder, input.status, adminId],
      )
      return rows[0] ? findById(id) : null
    },
    async setStatus(id, status, adminId) {
      const { rows } = await database.query<Row>(
        `update faqs set status = $2, featured = (featured and $2 = 'published'), updated_at = now(), updated_by = $3 where id = $1 returning id`,
        [id, status, adminId],
      )
      return rows[0] ? findById(id) : null
    },
    async countFeatured(excludingId) {
      const { rows } = await database.query<Row>("select count(*)::int as total from faqs where featured and status = 'published' and ($1::uuid is null or id <> $1::uuid)", [excludingId ?? null])
      return Number((rows[0] as Row).total)
    },
    async questionExists(topic, questionEn, excludingId) {
      const { rows } = await database.query<Row>('select 1 from faqs where topic_id = $1 and lower(trim(question_en)) = lower(trim($2)) and ($3::uuid is null or id <> $3::uuid) limit 1', [topic, questionEn, excludingId ?? null])
      return rows.length > 0
    },
  }
}
