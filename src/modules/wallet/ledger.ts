import type { PoolClient } from 'pg'
import type { WalletDirection, WalletEntryType } from './rules.js'

type Queryable = Pick<PoolClient, 'query'>
type Row = Record<string, unknown>

/**
 * The wallet balance, read inside the caller's transaction. Callers that take money out first lock the customer row
 * (`select ... from customers where id = $1 for update`), the same lock every other money change for that customer uses.
 */
export async function walletBalance(client: Queryable, customerId: string): Promise<number> {
  const { rows } = await client.query<Row>(
    "select coalesce(sum(case when direction = 'credit' then amount_paise else -amount_paise end), 0) as balance from wallet_entries where customer_id = $1",
    [customerId],
  )
  return Number((rows[0] as Row | undefined)?.balance ?? 0)
}

export type NewWalletEntry = {
  customerId: string; type: WalletEntryType; direction: WalletDirection; amountPaise: number; description: string
  paymentId?: string | null; orderId?: string | null; refundRequestId?: string | null; createdBy?: string | null
}

/**
 * Adds one permanent line. A line that already exists for the same payment, order or refund request is skipped (returns false),
 * so a repeated confirmation or a retry can never count money twice. The database also refuses a line that would take the
 * balance below zero.
 */
export async function addWalletEntry(client: Queryable, entry: NewWalletEntry): Promise<boolean> {
  const { rows } = await client.query<Row>(
    `insert into wallet_entries (customer_id, entry_type, direction, amount_paise, payment_id, order_id, refund_request_id, description, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing returning id`,
    [entry.customerId, entry.type, entry.direction, entry.amountPaise, entry.paymentId ?? null, entry.orderId ?? null, entry.refundRequestId ?? null, entry.description.slice(0, 300), entry.createdBy ?? null],
  )
  return rows.length > 0
}
