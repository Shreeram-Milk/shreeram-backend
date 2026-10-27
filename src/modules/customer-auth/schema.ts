import { z } from 'zod'

/**
 * Turns what a person typed into the one stored form, +<country code><number>.
 * "98246 12345", "09824612345", "919824612345" and "+91 98246 12345" all become +919824612345.
 * A bare 10-digit number is taken as an Indian mobile number (starts with 6 to 9).
 */
export function normalizePhone(input: string): string | null {
  const compact = input.replace(/[\s\-().]/g, '')
  if (/^\+[1-9][0-9]{7,14}$/.test(compact)) return compact
  const digits = compact.replace(/^0+/, '')
  if (/^[6-9][0-9]{9}$/.test(digits)) return `+91${digits}`
  if (/^91[6-9][0-9]{9}$/.test(digits)) return `+${digits}`
  return null
}

export const phoneSchema = z.string().trim().max(24).transform((value, context) => {
  const phone = normalizePhone(value)
  if (!phone) { context.addIssue({ code: 'custom', message: 'Enter a valid mobile number.' }); return z.NEVER }
  return phone
})

/** An optional contact number: empty is fine, anything else must be a valid mobile number. Stored as null when empty. */
const optionalPhoneSchema = z.string().trim().max(24).transform((value, context) => {
  if (value === '') return null
  const phone = normalizePhone(value)
  if (!phone) { context.addIssue({ code: 'custom', message: 'Enter a valid mobile number, or leave it empty.' }); return z.NEVER }
  return phone
})

/** The email a customer signs in with: trimmed, lower case, and shaped like an address. */
export const emailSchema = z.string().trim().toLowerCase().max(200, 'That email is too long.').refine(value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), 'Enter a valid email address.')

const codeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.')

/** The ID token the phone got from Google. Long, but never anywhere near 4 KB. */
export const googleSignInBody = z.object({ idToken: z.string().trim().min(20).max(4096), deviceLabel: z.string().trim().max(100).default('') })
export const requestCodeBody = z.object({ email: emailSchema })
export const verifyCodeBody = z.object({ email: emailSchema, code: codeSchema, deviceLabel: z.string().trim().max(100).default('') })
/** What a customer may change about themselves. Their email is how they sign in, so it is not changed here. */
export const updateProfileBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(100),
  phone: optionalPhoneSchema.default(null),
  language: z.enum(['en', 'gu']),
})
