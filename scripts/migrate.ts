import { resolve } from 'node:path'
import pg from 'pg'
import { loadEnv } from '../src/config/env.js'
import { sslOptions } from '../src/db/pool.js'
import { runMigrations } from '../src/db/migrations.js'

/** Applies pending migrations using the migration user, never the application user. */
async function main() {
  const env = loadEnv()
  if (!env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is not set. Migrations use their own database user.')
  const client = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL, ssl: sslOptions(env), connectionTimeoutMillis: 10_000 })
  await client.connect()
  try {
    const applied = await runMigrations(client, resolve('migrations'))
    console.log(applied.length ? `Applied ${applied.length} migration(s):\n${applied.map(name => `  - ${name}`).join('\n')}` : 'Database is up to date.')
  } finally {
    await client.end()
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
