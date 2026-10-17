import { readFileSync } from 'node:fs'
import pg from 'pg'
import type { Env } from '../config/env.js'

type DatabaseSettings = Pick<Env, 'DB_SSL' | 'DB_SSL_CA_PATH' | 'DB_TLS_SERVERNAME'>

/**
 * TLS settings for the database. Certificate checks stay on: when connecting through a tunnel on localhost, the
 * certificate belongs to the RDS hostname, so that name is passed as the expected server name instead of
 * turning verification off.
 */
export function sslOptions({ DB_SSL, DB_SSL_CA_PATH, DB_TLS_SERVERNAME }: DatabaseSettings): pg.ClientConfig['ssl'] {
  if (DB_SSL === 'disable') return false
  return { rejectUnauthorized: true, ...(DB_SSL_CA_PATH ? { ca: readFileSync(DB_SSL_CA_PATH, 'utf8') } : {}), ...(DB_TLS_SERVERNAME ? { servername: DB_TLS_SERVERNAME } : {}) }
}

/**
 * One shared pool for the app user. Short timeouts so a stuck query or an unreachable database fails fast.
 * An idle connection that the database drops (a restart, a tunnel reset) raises an `error` event; without a listener
 * Node would crash the whole API, so it is logged and the pool opens a fresh connection on the next query.
 */
export function createPool(connectionString: string, settings: DatabaseSettings): pg.Pool {
  const pool = new pg.Pool({ connectionString, ssl: sslOptions(settings), max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000 })
  pool.on('error', error => { console.error(`Database connection error: ${error.message}`) })
  return pool
}

export type Database = Pick<pg.Pool, 'query' | 'connect'>
