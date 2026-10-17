import type { Database } from '../../db/pool.js'
import { likePattern } from '../master-data/shared.js'
import type { CustomerListQuery, CustomerUpdate } from './schema.js'

/** A customer as the admin sees them. The sign-in code and session tables are never read here. */
export type AdminCustomer = {
  id: string
  phone: string | null
  name: string
  email: string
  language: 'en' | 'gu'
  customerType: 'prepaid' | 'credit'
  status: 'active' | 'blocked' | 'deleted'
  adminNote: string
  lastSignInAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CustomerRepository {
  list(query: CustomerListQuery): Promise<{ rows: AdminCustomer[]; total: number }>
  findById(id: string): Promise<AdminCustomer | null>
  /** Changes the allowed fields of a customer who has not deleted their account. Null when there is nothing to change. */
  update(id: string, changes: CustomerUpdate): Promise<AdminCustomer | null>
}

type Row = Record<string, unknown>
const COLUMNS = 'id, phone, name, email, language, customer_type, status, admin_note, last_sign_in_at, created_at, updated_at'
const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString()
const toCustomer = (row: Row): AdminCustomer => ({
  id: String(row.id),
  phone: row.phone === null ? null : String(row.phone),
  name: String(row.name),
  email: String(row.email),
  language: row.language === 'gu' ? 'gu' : 'en',
  customerType: row.customer_type === 'credit' ? 'credit' : 'prepaid',
  status: row.status === 'blocked' ? 'blocked' : row.status === 'deleted' ? 'deleted' : 'active',
  adminNote: String(row.admin_note),
  lastSignInAt: row.last_sign_in_at ? iso(row.last_sign_in_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
})

export function createCustomerRepository(database: Database): CustomerRepository {
  return {
    async list({ search, status, customerType, page, pageSize }) {
      // Customers who deleted their account only appear when asked for by status.
      const { rows } = await database.query<Row>(
        `select ${COLUMNS}, count(*) over() as total from customers
         where ($1::text is null and status <> 'deleted' or status = $1)
           and ($2::text is null or customer_type = $2)
           and ($3::text is null or name ilike $3 or phone ilike $3 or email ilike $3)
         order by created_at desc, id limit $4 offset $5`,
        [status ?? null, customerType ?? null, search ? likePattern(search) : null, pageSize, (page - 1) * pageSize],
      )
      return { rows: rows.map(toCustomer), total: rows[0] ? Number(rows[0].total) : 0 }
    },
    async findById(id) {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from customers where id = $1`, [id])
      return rows[0] ? toCustomer(rows[0]) : null
    },
    async update(id, { name, customerType, adminNote }) {
      const { rows } = await database.query<Row>(
        `update customers set name = $2, customer_type = $3, admin_note = $4, updated_at = now() where id = $1 and status <> 'deleted' returning ${COLUMNS}`,
        [id, name, customerType, adminNote],
      )
      return rows[0] ? toCustomer(rows[0]) : null
    },
  }
}
