import { createInterface, type Interface } from 'node:readline'
import pg from 'pg'
import { loadEnv } from '../src/config/env.js'
import { sslOptions } from '../src/db/pool.js'
import { hashPassword } from '../src/modules/auth/crypto.js'

/**
 * Creates (or, with --reset, changes the password of) an admin account. Run it yourself on your own machine:
 * the email and password are typed here and never go through chat, and the password is stored only as a hash.
 */
const MIN_PASSWORD_LENGTH = 8
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

type MutableInterface = Interface & { _writeToOutput?: (text: string) => void }

function ask(rl: MutableInterface, question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    const write = rl._writeToOutput?.bind(rl)
    if (hidden && rl._writeToOutput) {
      // Show the question once, then swallow what is typed, so the password never appears on screen.
      let questionShown = false
      rl._writeToOutput = text => { if (!questionShown) { questionShown = true; write?.(text) } else if (text.includes('\n')) write?.('\n') }
    }
    rl.question(question, answer => {
      if (write) rl._writeToOutput = write
      resolve(answer)
    })
  })
}

async function main() {
  const reset = process.argv.includes('--reset')
  const env = loadEnv()
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set in Backend/.env.local.')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as MutableInterface

  const email = (await ask(rl, 'Admin email: ')).trim().toLowerCase()
  if (!EMAIL.test(email)) throw new Error('That is not a valid email address.')
  const password = await ask(rl, `New password (at least ${MIN_PASSWORD_LENGTH} characters, hidden): `, true)
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  if ((await ask(rl, 'Type the password again: ', true)) !== password) throw new Error('The two passwords did not match. Nothing was saved.')
  rl.close()

  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: sslOptions(env), connectionTimeoutMillis: 10_000 })
  await client.connect()
  try {
    const hash = await hashPassword(password)
    const existing = await client.query('select 1 from admin_users where email = $1', [email])
    if (existing.rowCount && !reset) throw new Error(`An admin with ${email} already exists. Run with --reset to change their password.`)
    if (existing.rowCount) {
      await client.query("update admin_users set password_hash = $2, failed_login_count = 0, locked_until = null, status = 'active', updated_at = now() where email = $1", [email, hash])
      await client.query('update admin_sessions set revoked_at = now() where revoked_at is null and admin_user_id = (select id from admin_users where email = $1)', [email])
      console.log(`Password changed for ${email}. Any signed-in sessions were signed out.`)
    } else {
      await client.query('insert into admin_users (email, password_hash) values ($1, $2)', [email, hash])
      console.log(`Admin account created for ${email}.`)
    }
  } finally {
    await client.end()
  }
}

main().catch(error => { console.error(`\n${error instanceof Error ? error.message : error}`); process.exit(1) })
