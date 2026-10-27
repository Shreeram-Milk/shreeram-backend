import { withTransaction } from '../../db/transaction.js'
import type { Database } from '../../db/pool.js'
import { guardDelete, guardUnique, likePattern, type PageQuery, type RecordStatus, type Usage } from '../master-data/shared.js'
import type { CutoffCondition, CutoffRuleInput } from './schema.js'

export type CutoffRule = CutoffRuleInput & { id: string; updatedAt: string }

/** Storage for cut-off rules and their per-slot conditions. The Postgres version below is the real one; tests use a fake. */
export interface CutoffRuleRepository {
  list(query: PageQuery): Promise<{ rows: CutoffRule[]; total: number }>
  listAll(): Promise<CutoffRule[]>
  findById(id: string): Promise<CutoffRule | null>
  /** Saves the rule and its conditions as one all-or-nothing step. */
  create(input: CutoffRuleInput, adminId: string): Promise<CutoffRule>
  /** Saves the rule and replaces its conditions as one all-or-nothing step. */
  update(id: string, input: CutoffRuleInput, adminId: string): Promise<CutoffRule | null>
  setStatus(id: string, status: RecordStatus, adminId: string): Promise<CutoffRule | null>
  nameExists(name: string, excludingId?: string): Promise<boolean>
  /** The status of each requested slot; a slot that does not exist is left out. */
  slotStatuses(slotIds: string[]): Promise<Map<string, RecordStatus>>
  /** The start time ("06:00") of each requested slot; a slot that does not exist is left out. */
  slotStarts(slotIds: string[]): Promise<Map<string, string>>
  /** Products that use this rule. */
  usage(id: string): Promise<Usage[]>
  /** Deletes the record (and what belongs to it). Only called once `usage` says nothing uses it. */
  remove(id: string): Promise<boolean>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const RULE_COLUMNS = 'r.id, r.name, r.description, r.status, r.updated_at'
const CONDITIONS = `coalesce((select json_agg(json_build_object('deliverySlotId', c.delivery_slot_id, 'dayRelation', c.day_relation, 'cutoffTime', to_char(c.cutoff_time, 'HH24:MI'), 'cancelDayRelation', c.cancel_day_relation, 'cancelTime', to_char(c.cancel_time, 'HH24:MI')) order by s.start_time) from cutoff_conditions c join delivery_slots s on s.id = c.delivery_slot_id where c.cutoff_rule_id = r.id), '[]'::json) as conditions`
const toRule = (row: Row): CutoffRule => ({ id: String(row.id), name: String(row.name), description: String(row.description), status: row.status as RecordStatus, conditions: row.conditions as CutoffCondition[], updatedAt: iso(row.updated_at) })

export function createCutoffRuleRepository(database: Database): CutoffRuleRepository {
  async function findById(id: string): Promise<CutoffRule | null> {
    const { rows } = await database.query<Row>(`select ${RULE_COLUMNS}, ${CONDITIONS} from cutoff_rules r where r.id = $1`, [id])
    return rows[0] ? toRule(rows[0]) : null
  }
  const insertConditions = async (client: Pick<Database, 'query'>, ruleId: string, conditions: CutoffCondition[]) => {
    for (const condition of conditions) {
      await client.query('insert into cutoff_conditions (cutoff_rule_id, delivery_slot_id, day_relation, cutoff_time, cancel_day_relation, cancel_time) values ($1, $2, $3, $4, $5, $6)', [ruleId, condition.deliverySlotId, condition.dayRelation, condition.cutoffTime, condition.cancelDayRelation, condition.cancelTime])
    }
  }

  return {
    async list({ search, status, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${RULE_COLUMNS}, ${CONDITIONS}, count(*) over() as total from cutoff_rules r
          where ($1::text is null or r.status = $1) and ($2::text is null or r.name ilike $2)
          order by r.name limit $3 offset $4`,
        [status ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toRule), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    async listAll() { return (await database.query<Row>(`select ${RULE_COLUMNS}, ${CONDITIONS} from cutoff_rules r order by r.name`)).rows.map(toRule) },
    findById,
    create: (input, adminId) => guardUnique(async () => {
      const id = await withTransaction(database, async client => {
        const { rows } = await client.query<Row>('insert into cutoff_rules (name, description, status, updated_by) values ($1, $2, $3, $4) returning id', [input.name, input.description, input.status, adminId])
        const ruleId = String((rows[0] as Row).id)
        await insertConditions(client, ruleId, input.conditions)
        return ruleId
      })
      return (await findById(id)) as CutoffRule
    }),
    update: (id, input, adminId) => guardUnique(async () => {
      const found = await withTransaction(database, async client => {
        const { rows } = await client.query<Row>('update cutoff_rules set name = $2, description = $3, status = $4, updated_at = now(), updated_by = $5 where id = $1 returning id', [id, input.name, input.description, input.status, adminId])
        if (!rows[0]) return false
        await client.query('delete from cutoff_conditions where cutoff_rule_id = $1', [id])
        await insertConditions(client, id, input.conditions)
        return true
      })
      return found ? findById(id) : null
    }),
    async setStatus(id, status, adminId) {
      const { rows } = await database.query<Row>('update cutoff_rules set status = $2, updated_at = now(), updated_by = $3 where id = $1 returning id', [id, status, adminId])
      return rows[0] ? findById(id) : null
    },
    remove: id => guardDelete(async () => (await database.query<Row>('delete from cutoff_rules where id = $1 returning id', [id])).rows.length > 0, 'cut-off rule'),
    async nameExists(name, excludingId) {
      const { rows } = await database.query<Row>('select 1 from cutoff_rules where lower(trim(name)) = lower(trim($1)) and ($2::uuid is null or id <> $2::uuid) limit 1', [name, excludingId ?? null])
      return rows.length > 0
    },
    async slotStatuses(slotIds) {
      const { rows } = await database.query<Row>('select id, status from delivery_slots where id = any($1::uuid[])', [slotIds])
      return new Map(rows.map(row => [String(row.id), row.status as RecordStatus]))
    },
    async slotStarts(slotIds) {
      const { rows } = await database.query<Row>("select id, to_char(start_time, 'HH24:MI') as start_time from delivery_slots where id = any($1::uuid[])", [slotIds])
      return new Map(rows.map(row => [String(row.id), String(row.start_time)]))
    },
    async usage(id) {
      const { rows } = await database.query<Row>("select count(*)::int as total, coalesce((array_agg(name order by name))[1:5], '{}') as names from products where cutoff_rule_id = $1", [id])
      const row = rows[0] as Row
      return [{ label: 'products', count: Number(row.total), examples: (row.names as string[]) ?? [] }]
    },
  }
}
