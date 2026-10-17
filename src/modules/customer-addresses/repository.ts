import type { Database } from '../../db/pool.js'
import { withTransaction } from '../../db/transaction.js'
import { DEFAULT_DOORSTEP_INSTRUCTIONS, type AddressInput, type DoorstepInstructions } from './schema.js'

export type CustomerAddress = {
  id: string; label: 'home' | 'work' | 'other'; recipientName: string; recipientPhone: string
  line1: string; line2: string; landmark: string; city: string; pinCode: string; isDefault: boolean
}

/** Every query here is limited to one customer's own rows: an address id from someone else's account finds nothing. */
export interface CustomerAddressRepository {
  list(customerId: string): Promise<CustomerAddress[]>
  find(customerId: string, id: string): Promise<CustomerAddress | null>
  /** The first address is always the default. Making another the default clears the old one, in the same step. */
  create(customerId: string, input: AddressInput): Promise<CustomerAddress>
  update(customerId: string, id: string, input: AddressInput): Promise<CustomerAddress | null>
  /** Marks the address removed (old orders keep it). If it was the default, the oldest remaining one becomes the default. */
  remove(customerId: string, id: string): Promise<boolean>
  getInstructions(customerId: string): Promise<DoorstepInstructions>
  saveInstructions(customerId: string, instructions: DoorstepInstructions): Promise<DoorstepInstructions>
}

type Row = Record<string, unknown>
const COLUMNS = 'id, label, recipient_name, recipient_phone, line1, line2, landmark, city, pin_code, is_default'
const toAddress = (row: Row): CustomerAddress => ({
  id: String(row.id),
  label: row.label === 'work' ? 'work' : row.label === 'other' ? 'other' : 'home',
  recipientName: String(row.recipient_name),
  recipientPhone: String(row.recipient_phone),
  line1: String(row.line1),
  line2: String(row.line2),
  landmark: String(row.landmark),
  city: String(row.city),
  pinCode: String(row.pin_code),
  isDefault: Boolean(row.is_default),
})

const INSTRUCTION_COLUMNS = 'drop_location, handoff, no_doorbell, no_call, notify_after_delivery, additional_instructions'
const toInstructions = (row: Row): DoorstepInstructions => ({
  dropLocation: String(row.drop_location) as DoorstepInstructions['dropLocation'],
  handoff: String(row.handoff) as DoorstepInstructions['handoff'],
  noDoorbell: Boolean(row.no_doorbell),
  noCall: Boolean(row.no_call),
  notifyAfterDelivery: Boolean(row.notify_after_delivery),
  additionalInstructions: String(row.additional_instructions),
})

export function createCustomerAddressRepository(database: Database): CustomerAddressRepository {
  return {
    async list(customerId) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from customer_addresses where customer_id = $1 and removed_at is null order by is_default desc, created_at, id`, [customerId])
      return rows.map(toAddress)
    },
    async find(customerId, id) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from customer_addresses where customer_id = $1 and id = $2 and removed_at is null`, [customerId, id])
      return rows[0] ? toAddress(rows[0]) : null
    },
    create: (customerId, input) => withTransaction(database, async client => {
      // Lock the customer's row first, so two addresses saved at the same moment cannot both become the default.
      await client.query('select id from customers where id = $1 for update', [customerId])
      const existing = await client.query('select 1 from customer_addresses where customer_id = $1 and removed_at is null limit 1', [customerId])
      const isDefault = input.isDefault || existing.rowCount === 0
      if (isDefault) await client.query('update customer_addresses set is_default = false, updated_at = now() where customer_id = $1 and is_default and removed_at is null', [customerId])
      const { rows } = await client.query<Row>(
        `insert into customer_addresses (customer_id, label, recipient_name, recipient_phone, line1, line2, landmark, city, pin_code, is_default) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`,
        [customerId, input.label, input.recipientName, input.recipientPhone, input.line1, input.line2, input.landmark, input.city, input.pinCode, isDefault],
      )
      return toAddress(rows[0] as Row)
    }),
    update: (customerId, id, input) => withTransaction(database, async client => {
      await client.query('select id from customers where id = $1 for update', [customerId])
      const current = await client.query<Row>('select is_default from customer_addresses where customer_id = $1 and id = $2 and removed_at is null', [customerId, id])
      if (!current.rows[0]) return null
      // An address that is already the default stays the default; only choosing another one moves it.
      const isDefault = input.isDefault || Boolean(current.rows[0].is_default)
      if (isDefault) await client.query('update customer_addresses set is_default = false, updated_at = now() where customer_id = $1 and is_default and removed_at is null and id <> $2', [customerId, id])
      const { rows } = await client.query<Row>(
        `update customer_addresses set label = $3, recipient_name = $4, recipient_phone = $5, line1 = $6, line2 = $7, landmark = $8, city = $9, pin_code = $10, is_default = $11, updated_at = now() where customer_id = $1 and id = $2 returning ${COLUMNS}`,
        [customerId, id, input.label, input.recipientName, input.recipientPhone, input.line1, input.line2, input.landmark, input.city, input.pinCode, isDefault],
      )
      return rows[0] ? toAddress(rows[0]) : null
    }),
    remove: (customerId, id) => withTransaction(database, async client => {
      await client.query('select id from customers where id = $1 for update', [customerId])
      const removed = await client.query<Row>('update customer_addresses set removed_at = now(), is_default = false, updated_at = now() where customer_id = $1 and id = $2 and removed_at is null returning is_default', [customerId, id])
      if (removed.rowCount === 0) return false
      await client.query(
        'update customer_addresses set is_default = true, updated_at = now() where id = (select id from customer_addresses where customer_id = $1 and removed_at is null order by created_at, id limit 1) and not exists (select 1 from customer_addresses where customer_id = $1 and is_default and removed_at is null)',
        [customerId],
      )
      return true
    }),
    async getInstructions(customerId) {
      const { rows } = await database.query<Row>(`select ${INSTRUCTION_COLUMNS} from customer_doorstep_instructions where customer_id = $1`, [customerId])
      return rows[0] ? toInstructions(rows[0]) : DEFAULT_DOORSTEP_INSTRUCTIONS
    },
    async saveInstructions(customerId, instructions) {
      const { rows } = await database.query<Row>(
        `insert into customer_doorstep_instructions (customer_id, drop_location, handoff, no_doorbell, no_call, notify_after_delivery, additional_instructions) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (customer_id) do update set drop_location = excluded.drop_location, handoff = excluded.handoff, no_doorbell = excluded.no_doorbell, no_call = excluded.no_call, notify_after_delivery = excluded.notify_after_delivery, additional_instructions = excluded.additional_instructions, updated_at = now()
         returning ${INSTRUCTION_COLUMNS}`,
        [customerId, instructions.dropLocation, instructions.handoff, instructions.noDoorbell, instructions.noCall, instructions.notifyAfterDelivery, instructions.additionalInstructions],
      )
      return toInstructions(rows[0] as Row)
    },
  }
}
