import type { Database } from '../../db/pool.js'
import { guardDelete, guardUnique, likePattern, type PageQuery, type RecordStatus, type Usage } from '../master-data/shared.js'
import type { DeliverySlotInput } from './schema.js'

export type DeliverySlot = DeliverySlotInput & { id: string; updatedAt: string }

/** Storage for delivery slots. The Postgres version below is the real one; tests use a fake. */
export interface DeliverySlotRepository {
  list(query: PageQuery): Promise<{ rows: DeliverySlot[]; total: number }>
  /** Every slot, for pick-lists. There are only a handful. */
  listAll(): Promise<DeliverySlot[]>
  findById(id: string): Promise<DeliverySlot | null>
  create(input: DeliverySlotInput, adminId: string): Promise<DeliverySlot>
  update(id: string, input: DeliverySlotInput, adminId: string): Promise<DeliverySlot | null>
  setStatus(id: string, status: RecordStatus, adminId: string): Promise<DeliverySlot | null>
  nameExists(name: string, excludingId?: string): Promise<boolean>
  /** What uses this slot: PIN codes that allow it and cut-off conditions that name it. */
  usage(id: string): Promise<Usage[]>
  /** Deletes the record (and what belongs to it). Only called once `usage` says nothing uses it. */
  remove(id: string): Promise<boolean>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const COLUMNS = "id, name, description, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, status, updated_at"
const toSlot = (row: Row): DeliverySlot => ({ id: String(row.id), name: String(row.name), description: String(row.description), startTime: String(row.start_time), endTime: String(row.end_time), status: row.status as RecordStatus, updatedAt: iso(row.updated_at) })

export function createDeliverySlotRepository(database: Database): DeliverySlotRepository {
  async function findById(id: string): Promise<DeliverySlot | null> {
    const { rows } = await database.query<Row>(`select ${COLUMNS} from delivery_slots where id = $1`, [id])
    return rows[0] ? toSlot(rows[0]) : null
  }
  return {
    async list({ search, status, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${COLUMNS}, count(*) over() as total from delivery_slots
          where ($1::text is null or status = $1) and ($2::text is null or name ilike $2)
          order by start_time, name limit $3 offset $4`,
        [status ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toSlot), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    async listAll() { return (await database.query<Row>(`select ${COLUMNS} from delivery_slots order by start_time, name`)).rows.map(toSlot) },
    findById,
    create: (input, adminId) => guardUnique(async () => {
      const { rows } = await database.query<Row>('insert into delivery_slots (name, description, start_time, end_time, status, updated_by) values ($1, $2, $3, $4, $5, $6) returning id', [input.name, input.description, input.startTime, input.endTime, input.status, adminId])
      return (await findById(String((rows[0] as Row).id))) as DeliverySlot
    }),
    update: (id, input, adminId) => guardUnique(async () => {
      const { rows } = await database.query<Row>('update delivery_slots set name = $2, description = $3, start_time = $4, end_time = $5, status = $6, updated_at = now(), updated_by = $7 where id = $1 returning id', [id, input.name, input.description, input.startTime, input.endTime, input.status, adminId])
      return rows[0] ? findById(id) : null
    }),
    async setStatus(id, status, adminId) {
      const { rows } = await database.query<Row>('update delivery_slots set status = $2, updated_at = now(), updated_by = $3 where id = $1 returning id', [id, status, adminId])
      return rows[0] ? findById(id) : null
    },
    remove: id => guardDelete(async () => (await database.query<Row>('delete from delivery_slots where id = $1 returning id', [id])).rows.length > 0, 'delivery slot'),
    async nameExists(name, excludingId) {
      const { rows } = await database.query<Row>('select 1 from delivery_slots where lower(trim(name)) = lower(trim($1)) and ($2::uuid is null or id <> $2::uuid) limit 1', [name, excludingId ?? null])
      return rows.length > 0
    },
    async usage(id) {
      const { rows } = await database.query<Row>(
        `select
           (select count(distinct p.service_area_id)::int from service_area_pin_slots s join service_area_pins p on p.id = s.pin_id where s.delivery_slot_id = $1) as areas,
           (select coalesce(array_agg(distinct a.name), '{}') from service_area_pin_slots s join service_area_pins p on p.id = s.pin_id join service_areas a on a.id = p.service_area_id where s.delivery_slot_id = $1) as area_names,
           (select count(distinct cutoff_rule_id)::int from cutoff_conditions where delivery_slot_id = $1) as rules,
           (select coalesce(array_agg(distinct r.name), '{}') from cutoff_conditions c join cutoff_rules r on r.id = c.cutoff_rule_id where c.delivery_slot_id = $1) as rule_names`,
        [id],
      )
      const row = rows[0] as Row
      return [
        { label: 'service areas', count: Number(row.areas), examples: ((row.area_names as string[]) ?? []).slice(0, 5) },
        { label: 'cut-off rules', count: Number(row.rules), examples: ((row.rule_names as string[]) ?? []).slice(0, 5) },
      ]
    },
  }
}
