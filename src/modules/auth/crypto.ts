import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

// scrypt is built into Node, so no extra package is needed. These settings use about 32 MB and ~100 ms per check:
// slow enough to make guessing expensive, fast enough that signing in feels instant.
const COST = 32_768
const BLOCK_SIZE = 8
const PARALLELISM = 1
const KEY_LENGTH = 64
const MAX_MEMORY = 128 * 1024 * 1024

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key))))
}

/** Stores a password as `scrypt$cost$blockSize$parallelism$salt$hash`. The password itself is never kept. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEMORY })
  return ['scrypt', COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), key.toString('base64url')].join('$')
}

/** Checks a password against a stored hash in constant time. A malformed stored hash simply fails. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, blockSize, parallelism, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !cost || !blockSize || !parallelism || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const actual = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(cost), r: Number(blockSize), p: Number(parallelism), maxmem: MAX_MEMORY })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

let dummyHash: Promise<string> | undefined
/**
 * A real hash of a throwaway password. Checking against it when the email is unknown makes "no such account" take
 * as long as "wrong password", so response time does not reveal which emails exist.
 */
export const decoyHash = (): Promise<string> => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')))

/** A long random token for a session cookie. Only its hash is stored, so a database leak cannot sign anyone in. */
export const newToken = (): string => randomBytes(32).toString('base64url')

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A 6-digit one-time code. */
export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0')

/**
 * Hash of a one-time code, keyed with the server secret. A plain hash of a 6-digit number could be reversed in a
 * moment; the secret makes a stolen copy of the table useless for working out codes.
 */
export const hashCode = (secret: string, adminId: string, code: string): string => createHmac('sha256', secret).update(`${adminId}:${code}`).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
