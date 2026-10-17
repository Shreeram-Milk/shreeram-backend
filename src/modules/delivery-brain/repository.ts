import type { Database } from '../../db/pool.js'
import type { DeliveryMethod } from '../products/schema.js'
import type { CoverageType } from '../service-areas/schema.js'
import type { CutoffCondition } from './rules.js'

export type BrainSlot = { slotId: string; name: string; startTime: string; endTime: string }
/** How one product is delivered: the method, the area, and the cut-off times for that area's slots. */
export type BrainSetup = {
  /** Stable key for this exact combination of method, area and cut-off rule. */
  id: string
  /** The delivery area's name, for the Location screen. */
  name: string
  deliveryMethod: DeliveryMethod
  area: { id: string; coverageType: CoverageType; status: 'active' | 'inactive'; state: string }
  /** The product's cut-off rule, one entry per slot; empty when the product has none. */
  conditions: Array<CutoffCondition & { deliverySlotId: string }>
}

/** The read-only questions the delivery brain asks. The Postgres version below is the real one; tests use a fake. */
export interface DeliveryBrainRepository {
  /** How a live product is delivered, or null when the product is not live or is not set up for delivery. */
  findProductSetup(productId: string): Promise<BrainSetup | null>
  /** The different ways the live products are delivered (one entry per method, area and cut-off rule), at most `limit`, in area-name order. */
  listActiveSetups(limit: number): Promise<BrainSetup[]>
  /** An active PIN of the area with its active slots, or null when the PIN is not there, is switched off, or has no active slot. */
  findServedPin(areaId: string, pinCode: string): Promise<{ locality: string; slots: BrainSlot[] } | null>
  /** The state(s) the national PIN directory gives this PIN; empty when the directory does not know it. */
  directoryStates(pinCode: string): Promise<string[]>
}

type Row = Record<string, unknown>

const CONDITIONS = `coalesce((select jsonb_agg(jsonb_build_object('deliverySlotId', c.delivery_slot_id, 'dayRelation', c.day_relation, 'cutoffTime', to_char(c.cutoff_time, 'HH24:MI'), 'cancelDayRelation', c.cancel_day_relation, 'cancelTime', to_char(c.cancel_time, 'HH24:MI')))
                     from cutoff_conditions c where c.cutoff_rule_id = p.cutoff_rule_id), '[]'::jsonb) as conditions`
const SETUP_FROM = `from products p join service_areas a on a.id = p.service_area_id
         where p.status = 'active' and a.status = 'active' and p.delivery_method is not null`

const toSetup = (row: Row): BrainSetup => ({
  id: `${String(row.delivery_method)}:${String(row.area_id)}:${row.cutoff_rule_id ? String(row.cutoff_rule_id) : 'none'}`, name: String(row.area_name), deliveryMethod: row.delivery_method as DeliveryMethod,
  area: { id: String(row.area_id), coverageType: row.coverage_type as CoverageType, status: row.area_status as BrainSetup['area']['status'], state: String(row.state) },
  conditions: row.conditions as BrainSetup['conditions'],
})

export function createDeliveryBrainRepository(database: Database): DeliveryBrainRepository {
  return {
    async findProductSetup(productId) {
      const { rows } = await database.query<Row>(
        `select p.delivery_method, p.cutoff_rule_id, a.id as area_id, a.name as area_name, a.coverage_type, a.status as area_status, a.state, ${CONDITIONS} ${SETUP_FROM} and p.id = $1`,
        [productId],
      )
      return rows[0] ? toSetup(rows[0]) : null
    },
    async listActiveSetups(limit) {
      const { rows } = await database.query<Row>(
        `select distinct p.delivery_method, p.cutoff_rule_id, a.id as area_id, a.name as area_name, a.coverage_type, a.status as area_status, a.state, ${CONDITIONS} ${SETUP_FROM} order by a.name, p.delivery_method limit $1`,
        [limit],
      )
      return rows.map(toSetup)
    },
    async findServedPin(areaId, pinCode) {
      const { rows } = await database.query<Row>(
        `select p.locality, s.id as slot_id, s.name, to_char(s.start_time, 'HH24:MI') as start_time, to_char(s.end_time, 'HH24:MI') as end_time
         from service_area_pins p
           join service_area_pin_slots ps on ps.pin_id = p.id
           join delivery_slots s on s.id = ps.delivery_slot_id and s.status = 'active'
         where p.service_area_id = $1 and p.pin_code = $2 and p.status = 'active'
         order by s.start_time, s.name`,
        [areaId, pinCode],
      )
      const first = rows[0]
      if (!first) return null
      return { locality: String(first.locality), slots: rows.map(row => ({ slotId: String(row.slot_id), name: String(row.name), startTime: String(row.start_time), endTime: String(row.end_time) })) }
    },
    async directoryStates(pinCode) {
      const { rows } = await database.query<Row>('select distinct state from pin_directory where pin_code = $1', [pinCode])
      return rows.map(row => String(row.state))
    },
  }
}
