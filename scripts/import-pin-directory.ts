import { readFileSync } from 'node:fs'
import pg from 'pg'
import { loadEnv } from '../src/config/env.js'
import { sslOptions } from '../src/db/pool.js'
import { parseCsv, parseDirectory, parseGeoNames } from '../src/modules/pin-directory/parse.js'

/**
 * Loads a national PIN directory into `pin_directory`. Two file kinds are understood:
 *   the India Post CSV from data.gov.in (the default), and the GeoNames file `IN.txt` (add --geonames).
 *   npm run import-pins -- path\to\IN.txt --geonames --dry-run   (reads the file and reports; changes nothing)
 *   npm run import-pins -- path\to\IN.txt --geonames             (loads it; PINs already there are skipped)
 * Uses the migration user, never the application user.
 */
const BATCH = 2000

async function main() {
  const [path, ...flags] = process.argv.slice(2)
  if (!path) throw new Error('Give the path of the CSV file, for example: npm run import-pins -- data\\pincode.csv')
  const dryRun = flags.includes('--dry-run')
  const text = readFileSync(path, 'utf8')
  const { rows, read, skipped } = flags.includes('--geonames') ? parseGeoNames(text) : parseDirectory(parseCsv(text))
  const states = new Set(rows.map(row => row.state))
  console.log(`Read ${read} lines: ${rows.length} usable post offices in ${new Set(rows.map(row => row.pinCode)).size} PIN codes across ${states.size} states/territories; ${skipped} lines skipped (no valid PIN or state).`)
  console.log('Sample:', rows.slice(0, 3).map(row => `${row.pinCode} ${row.officeName} / ${row.district} / ${row.state}`).join('  |  '))
  if (dryRun) { console.log('Dry run: nothing was changed.'); return }

  const env = loadEnv()
  if (!env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is not set. This import uses the migration database user.')
  const client = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL, ssl: sslOptions(env), connectionTimeoutMillis: 10_000 })
  await client.connect()
  try {
    await client.query('begin')
    let added = 0
    for (let start = 0; start < rows.length; start += BATCH) {
      const batch = rows.slice(start, start + BATCH)
      const result = await client.query(
        'insert into pin_directory (pin_code, office_name, district, state) select * from unnest($1::text[], $2::text[], $3::text[], $4::text[]) on conflict (pin_code, office_name) do nothing',
        [batch.map(row => row.pinCode), batch.map(row => row.officeName), batch.map(row => row.district), batch.map(row => row.state)],
      )
      added += result.rowCount ?? 0
    }
    await client.query('commit')
    console.log(`Done: ${added} post offices added, ${rows.length - added} were already there.`)
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
