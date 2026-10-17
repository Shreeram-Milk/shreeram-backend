import type { PoolClient } from 'pg'
import type { Database } from './pool.js'

/**
 * Runs several statements as one all-or-nothing step. If any of them fails, none of them stick. Keep the work short
 * and never call an outside service (S3, SMS, payments) inside it.
 */
export async function withTransaction<T>(database: Database, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect()
  try {
    await client.query('begin')
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
