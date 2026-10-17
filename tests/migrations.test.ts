import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planMigrations, readMigrationFiles, type MigrationFile } from '../src/db/migrations.js'
import { sslOptions } from '../src/db/pool.js'

const file = (name: string, checksum = 'a'): MigrationFile => ({ name, sql: 'select 1', checksum })
const directories: string[] = []
const folder = (files: Record<string, string>) => {
  const directory = mkdtempSync(join(tmpdir(), 'migrations-'))
  directories.push(directory)
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(directory, name), sql)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('migration files', () => {
  it('reads them in numeric order and ignores non-SQL files', () => {
    const files = readMigrationFiles(folder({ '0002_b.sql': 'select 2', '0001_a.sql': 'select 1', '.gitkeep': '' }))
    expect(files.map(item => item.name)).toEqual(['0001_a.sql', '0002_b.sql'])
  })
  it('rejects badly named files', () => {
    expect(() => readMigrationFiles(folder({ 'create_users.sql': 'select 1' }))).toThrow(/must be named like/)
  })
  it('gives the same checksum for the same text and a different one when it changes', () => {
    const one = readMigrationFiles(folder({ '0001_a.sql': 'select 1' }))[0]
    const same = readMigrationFiles(folder({ '0001_a.sql': 'select 1' }))[0]
    const changed = readMigrationFiles(folder({ '0001_a.sql': 'select 2' }))[0]
    expect([one?.checksum === same?.checksum, one?.checksum === changed?.checksum]).toEqual([true, false])
  })
})

describe('migration plan', () => {
  it('returns only the migrations that have not run yet', () => {
    const plan = planMigrations([file('0001_a.sql'), file('0002_b.sql')], new Map([['0001_a.sql', 'a']]))
    expect(plan.map(item => item.name)).toEqual(['0002_b.sql'])
  })
  it('refuses an applied migration that was edited, a repeated number, or a missing file', () => {
    expect(() => planMigrations([file('0001_a.sql', 'new')], new Map([['0001_a.sql', 'old']]))).toThrow(/changed since/)
    expect(() => planMigrations([file('0001_a.sql'), file('0001_b.sql')], new Map())).toThrow(/share the number/)
    expect(() => planMigrations([file('0001_a.sql')], new Map([['0001_a.sql', 'a'], ['0002_b.sql', 'b']]))).toThrow(/file is missing/)
  })
})

describe('database TLS', () => {
  it('keeps certificate checks on and passes the RDS hostname as the expected server name', () => {
    expect(sslOptions({ DB_SSL: 'require', DB_SSL_CA_PATH: undefined, DB_TLS_SERVERNAME: 'db.example.rds.amazonaws.com' })).toEqual({ rejectUnauthorized: true, servername: 'db.example.rds.amazonaws.com' })
  })
  it('can be turned off only by an explicit setting, for a local database', () => {
    expect(sslOptions({ DB_SSL: 'disable', DB_SSL_CA_PATH: undefined, DB_TLS_SERVERNAME: undefined })).toBe(false)
  })
})
