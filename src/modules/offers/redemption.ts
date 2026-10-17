import type { PoolClient } from 'pg'
import { AppError } from '../../http/errors.js'

type Row = Record<string, unknown>

/**
 * Locks the offer's row and refuses the checkout when the offer was switched off or used up since the customer saw it.
 * Two checkouts at once cannot both take the last use. `checkoutKey` groups the orders of one checkout, which count once.
 */
export async function lockOffer(client: Pick<PoolClient, 'query'>, customerId: string, offer: { id: string; checkoutKey: string }): Promise<void> {
  const { rows } = await client.query<Row>('select status, total_limit, per_customer_limit from offers where id = $1 for update', [offer.id])
  const row = rows[0]
  if (!row || row.status !== 'active') throw new AppError(409, 'OFFER_NOT_LIVE', 'That offer has ended.')
  const { rows: usedRows } = await client.query<Row>(
    `select count(distinct checkout_key)::int as total, count(distinct checkout_key) filter (where customer_id = $2)::int as mine
     from offer_redemptions where offer_id = $1 and checkout_key <> $3`,
    [offer.id, customerId, offer.checkoutKey],
  )
  const used = usedRows[0] as Row
  if (row.total_limit !== null && Number(used.total) >= Number(row.total_limit)) throw new AppError(409, 'OFFER_LIMIT_REACHED', 'That offer has been used up.')
  if (row.per_customer_limit !== null && Number(used.mine) >= Number(row.per_customer_limit)) throw new AppError(409, 'OFFER_ALREADY_USED', 'You have already used that offer the most times allowed.')
}
