import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'

export type MigrationFile = { name: string; sql: string; checksum: string }

const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/

/** Migration files in the order they must run: `0001_name.sql`, `0002_name.sql`, and so on. */
export function readMigrationFiles(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .map(name => {
      if (!FILE_NAME.test(name)) throw new Error(`Migration file "${name}" must be named like 0001_create_customers.sql.`)
      const sql = readFileSync(join(directory, name), 'utf8')
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Checks the list before anything runs: no repeated numbers, and no already-applied file that has since been edited. */
export function planMigrations(files: MigrationFile[], applied: Map<string, string>): MigrationFile[] {
  const numbers = new Set<string>()
  for (const file of files) {
    const number = file.name.slice(0, 4)
    if (numbers.has(number)) throw new Error(`Two migrations share the number ${number}. Renumber one of them.`)
    numbers.add(number)
    const previous = applied.get(file.name)
    if (previous && previous !== file.checksum) throw new Error(`Migration ${file.name} was already applied and has been changed since. Add a new migration instead of editing it.`)
  }
  for (const name of applied.keys()) if (!files.some(file => file.name === name)) throw new Error(`The database has migration ${name} but its file is missing.`)
  return files.filter(file => !applied.has(file.name))
}

/** Applies each pending migration in its own transaction, so a failure leaves no half-applied change. */
export async function runMigrations(client: pg.Client, directory: string): Promise<string[]> {
  await client.query('create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())')
  const rows = await client.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')
  const pending = planMigrations(readMigrationFiles(directory), new Map(rows.rows.map(row => [row.name, row.checksum])))
  for (const migration of pending) {
    try {
      await client.query('begin')
      await client.query(migration.sql)
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [migration.name, migration.checksum])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw new Error(`Migration ${migration.name} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return pending.map(migration => migration.name)
}
