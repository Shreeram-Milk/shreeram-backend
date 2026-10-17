import type { Database } from '../../db/pool.js'

export type DirectoryPin = { pinCode: string; offices: string[] }

/** Read-only questions about the national PIN directory. The Postgres version below is the real one; tests use a fake. */
export interface PinDirectoryRepository {
  listStates(): Promise<string[]>
  listDistricts(state: string): Promise<string[]>
  /** The PIN codes of one district, each with its post office names, in PIN order. At most `limit` PINs. */
  listPins(state: string, district: string, limit: number): Promise<DirectoryPin[]>
}

type Row = Record<string, unknown>

export function createPinDirectoryRepository(database: Database): PinDirectoryRepository {
  return {
    async listStates() {
      const { rows } = await database.query<Row>('select distinct state from pin_directory order by state')
      return rows.map(row => String(row.state))
    },
    async listDistricts(state) {
      const { rows } = await database.query<Row>("select distinct district from pin_directory where lower(state) = lower($1) and district <> '' order by district", [state])
      return rows.map(row => String(row.district))
    },
    async listPins(state, district, limit) {
      const { rows } = await database.query<Row>(
        `select pin_code, array_agg(office_name order by office_name) filter (where office_name <> '') as offices
         from pin_directory where lower(state) = lower($1) and lower(district) = lower($2)
         group by pin_code order by pin_code limit $3`,
        [state, district, limit],
      )
      return rows.map(row => ({ pinCode: String(row.pin_code), offices: (row.offices as string[] | null) ?? [] }))
    },
  }
}
