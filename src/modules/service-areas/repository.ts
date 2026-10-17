import { withTransaction } from '../../db/transaction.js'
import type { Database } from '../../db/pool.js'
import { AppError } from '../../http/errors.js'
import { guardDelete, guardUnique, likePattern, type PageQuery, type RecordStatus, type Usage } from '../master-data/shared.js'
import type { CoverageType, PinInput, PinListQuery, ServiceAreaInput } from './schema.js'

/** Everything saved about an area, plus how many PIN codes it has and which slots those PINs allow (for the list screen). */
export type ServiceArea = Omit<ServiceAreaInput, 'confirmRemovePins'> & { id: string; updatedAt: string; pinCount: number; slotIds: string[] }
export type Pin = PinInput & { id: string }
export type NewPin = Omit<PinInput, 'status'> & { status: RecordStatus }

/** Storage for service areas and their PIN codes. The Postgres version below is the real one; tests use a fake. */
export interface ServiceAreaRepository {
  list(query: PageQuery): Promise<{ rows: ServiceArea[]; total: number }>
  listAll(): Promise<ServiceArea[]>
  findById(id: string): Promise<ServiceArea | null>
  create(input: ServiceAreaInput, adminId: string): Promise<ServiceArea>
  /** Saves the area. With `removePins`, its PIN codes are deleted in the same all-or-nothing step. */
  update(id: string, input: ServiceAreaInput, adminId: string, removePins: boolean): Promise<ServiceArea | null>
  setStatus(id: string, status: RecordStatus, adminId: string): Promise<ServiceArea | null>
  nameExists(name: string, excludingId?: string): Promise<boolean>
  /** Products that use this area. */
  usage(id: string): Promise<Usage[]>
  /** Deletes the record (and what belongs to it). Only called once `usage` says nothing uses it. */
  remove(id: string): Promise<boolean>
  /** How many products of this area could not work if the area became `coverage`. */
  countProductsBrokenBy(id: string, coverage: CoverageType): Promise<number>

  listPins(areaId: string, query: PinListQuery): Promise<{ rows: Pin[]; total: number }>
  findPin(areaId: string, pinId: string): Promise<Pin | null>
  createPin(areaId: string, input: PinInput): Promise<Pin>
  updatePin(areaId: string, pinId: string, input: PinInput): Promise<Pin | null>
  /** Adds the PIN codes that are not already in the area; returns the ones it added. */
  addPins(areaId: string, entries: Array<{ pinCode: string; locality: string }>, settings: Pick<NewPin, 'allowedDeliverySlotIds' | 'status'>): Promise<string[]>
  pinExists(areaId: string, pinCode: string, excludingPinId?: string): Promise<boolean>
  /** The status of each requested slot; a slot that does not exist is left out. */
  slotStatuses(slotIds: string[]): Promise<Map<string, RecordStatus>>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const AREA_SELECT = `a.id, a.name, a.description, a.coverage_type, a.state, a.city, a.status, a.updated_at,
  (select count(*)::int from service_area_pins p where p.service_area_id = a.id) as pin_count,
  coalesce((select array_agg(distinct s.delivery_slot_id::text) from service_area_pin_slots s join service_area_pins p on p.id = s.pin_id where p.service_area_id = a.id), '{}'::text[]) as slot_ids`
const PIN_SELECT = "p.id, p.pin_code, p.locality, p.status, coalesce(array_agg(s.delivery_slot_id::text order by s.delivery_slot_id) filter (where s.delivery_slot_id is not null), '{}'::text[]) as slot_ids"

const toArea = (row: Row): ServiceArea => ({
  id: String(row.id), name: String(row.name), description: String(row.description), coverageType: row.coverage_type as CoverageType, state: String(row.state), city: String(row.city),
  status: row.status as RecordStatus, updatedAt: iso(row.updated_at), pinCount: Number(row.pin_count), slotIds: (row.slot_ids as string[]) ?? [],
})
const toPin = (row: Row): Pin => ({ id: String(row.id), pinCode: String(row.pin_code), locality: String(row.locality), status: row.status as RecordStatus, allowedDeliverySlotIds: (row.slot_ids as string[]) ?? [] })

const pinExistsError = () => new AppError(409, 'PIN_EXISTS', 'This PIN code already exists in this service area.')
const isUniqueViolation = (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'

export function createServiceAreaRepository(database: Database): ServiceAreaRepository {
  async function findById(id: string): Promise<ServiceArea | null> {
    const { rows } = await database.query<Row>(`select ${AREA_SELECT} from service_areas a where a.id = $1`, [id])
    return rows[0] ? toArea(rows[0]) : null
  }
  async function findPin(areaId: string, pinId: string): Promise<Pin | null> {
    const { rows } = await database.query<Row>(`select ${PIN_SELECT} from service_area_pins p left join service_area_pin_slots s on s.pin_id = p.id where p.service_area_id = $1 and p.id = $2 group by p.id`, [areaId, pinId])
    return rows[0] ? toPin(rows[0]) : null
  }
  const setPinSlots = async (client: Pick<Database, 'query'>, pinId: string, slotIds: string[]) => {
    await client.query('delete from service_area_pin_slots where pin_id = $1', [pinId])
    await client.query('insert into service_area_pin_slots (pin_id, delivery_slot_id) select $1, unnest($2::uuid[])', [pinId, slotIds])
  }

  return {
    async list({ search, status, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${AREA_SELECT}, count(*) over() as total from service_areas a
          where ($1::text is null or a.status = $1) and ($2::text is null or a.name ilike $2 or a.city ilike $2 or a.state ilike $2)
          order by a.name limit $3 offset $4`,
        [status ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toArea), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    async listAll() { return (await database.query<Row>(`select ${AREA_SELECT} from service_areas a order by a.name`)).rows.map(toArea) },
    findById,
    create: (input, adminId) => guardUnique(async () => {
      const { rows } = await database.query<Row>(
        'insert into service_areas (name, description, coverage_type, state, city, status, updated_by) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [input.name, input.description, input.coverageType, input.state, input.city, input.status, adminId],
      )
      return (await findById(String((rows[0] as Row).id))) as ServiceArea
    }),
    update: (id, input, adminId, removePins) => guardUnique(async () => {
      const found = await withTransaction(database, async client => {
        const { rows } = await client.query<Row>(
          'update service_areas set name = $2, description = $3, coverage_type = $4, state = $5, city = $6, status = $7, updated_at = now(), updated_by = $8 where id = $1 returning id',
          [id, input.name, input.description, input.coverageType, input.state, input.city, input.status, adminId],
        )
        if (!rows[0]) return false
        if (removePins) await client.query('delete from service_area_pins where service_area_id = $1', [id])
        return true
      })
      return found ? findById(id) : null
    }),
    async setStatus(id, status, adminId) {
      const { rows } = await database.query<Row>('update service_areas set status = $2, updated_at = now(), updated_by = $3 where id = $1 returning id', [id, status, adminId])
      return rows[0] ? findById(id) : null
    },
    remove: id => guardDelete(async () => (await database.query<Row>('delete from service_areas where id = $1 returning id', [id])).rows.length > 0, 'service area'),
    async nameExists(name, excludingId) {
      const { rows } = await database.query<Row>('select 1 from service_areas where lower(trim(name)) = lower(trim($1)) and ($2::uuid is null or id <> $2::uuid) limit 1', [name, excludingId ?? null])
      return rows.length > 0
    },
    async usage(id) {
      const { rows } = await database.query<Row>("select count(*)::int as total, coalesce((array_agg(name order by name))[1:5], '{}') as names from products where service_area_id = $1", [id])
      const row = rows[0] as Row
      return [{ label: 'products', count: Number(row.total), examples: (row.names as string[]) ?? [] }]
    },
    async countProductsBrokenBy(id, coverage) {
      const { rows } = await database.query<Row>(
        "select count(*)::int as total from products where service_area_id = $1 and ((delivery_method = 'local_delivery' and $2 <> 'pin_code') or (delivery_method = 'shipping' and $2 = 'pin_code'))",
        [id, coverage],
      )
      return Number((rows[0] as Row).total)
    },

    async listPins(areaId, { search, status, slotId, page, pageSize }) {
      const { rows } = await database.query<Row>(
        `select ${PIN_SELECT}, count(*) over() as total from service_area_pins p left join service_area_pin_slots s on s.pin_id = p.id
          where p.service_area_id = $1 and ($2::text is null or p.status = $2) and ($3::text is null or p.pin_code ilike $3 or p.locality ilike $3)
            and ($4::uuid is null or exists (select 1 from service_area_pin_slots x where x.pin_id = p.id and x.delivery_slot_id = $4::uuid))
          group by p.id order by p.pin_code limit $5 offset $6`,
        [areaId, status ?? null, search ? likePattern(search) : null, slotId ?? null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toPin), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    findPin,
    async createPin(areaId, input) {
      try {
        const pinId = await withTransaction(database, async client => {
          const { rows } = await client.query<Row>('insert into service_area_pins (service_area_id, pin_code, locality, status) values ($1, $2, $3, $4) returning id', [areaId, input.pinCode, input.locality, input.status])
          const id = String((rows[0] as Row).id)
          await setPinSlots(client, id, input.allowedDeliverySlotIds)
          return id
        })
        return (await findPin(areaId, pinId)) as Pin
      } catch (error) { throw isUniqueViolation(error) ? pinExistsError() : error }
    },
    async updatePin(areaId, pinId, input) {
      try {
        const found = await withTransaction(database, async client => {
          const { rows } = await client.query<Row>('update service_area_pins set pin_code = $3, locality = $4, status = $5 where service_area_id = $1 and id = $2 returning id', [areaId, pinId, input.pinCode, input.locality, input.status])
          if (!rows[0]) return false
          await setPinSlots(client, pinId, input.allowedDeliverySlotIds)
          return true
        })
        return found ? findPin(areaId, pinId) : null
      } catch (error) { throw isUniqueViolation(error) ? pinExistsError() : error }
    },
    async addPins(areaId, entries, settings) {
      return withTransaction(database, async client => {
        const { rows } = await client.query<Row>(
          'insert into service_area_pins (service_area_id, pin_code, locality, status) select $1, p, l, $4 from unnest($2::text[], $3::text[]) as t(p, l) on conflict (service_area_id, pin_code) do nothing returning id, pin_code',
          [areaId, entries.map(entry => entry.pinCode), entries.map(entry => entry.locality), settings.status],
        )
        const ids = rows.map(row => String(row.id))
        if (ids.length > 0) {
          await client.query('insert into service_area_pin_slots (pin_id, delivery_slot_id) select p, s from unnest($1::uuid[]) as p cross join unnest($2::uuid[]) as s', [ids, settings.allowedDeliverySlotIds])
        }
        return rows.map(row => String(row.pin_code))
      })
    },
    async pinExists(areaId, pinCode, excludingPinId) {
      const { rows } = await database.query<Row>('select 1 from service_area_pins where service_area_id = $1 and pin_code = $2 and ($3::uuid is null or id <> $3::uuid) limit 1', [areaId, pinCode, excludingPinId ?? null])
      return rows.length > 0
    },
    async slotStatuses(slotIds) {
      const { rows } = await database.query<Row>('select id, status from delivery_slots where id = any($1::uuid[])', [slotIds])
      return new Map(rows.map(row => [String(row.id), row.status as RecordStatus]))
    },
  }
}
