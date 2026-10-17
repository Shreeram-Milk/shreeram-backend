import { z } from 'zod'
import { AppError } from '../../http/errors.js'

/** A record nothing uses can be deleted; one that is used can only be switched to inactive, so old orders keep making sense. */
export const RECORD_STATUSES = ['active', 'inactive'] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

export const nameField = z.string().trim().min(1, 'Enter a name.').max(80, 'Keep the name under 80 characters.')
export const descriptionField = z.string().trim().max(300, 'Keep the description under 300 characters.').default('')
export const recordIdParamsSchema = z.object({ id: z.uuid('That is not a valid id.') })
/** `confirmInUse` is the admin saying "yes, I saw what uses this and still want to switch it off". */
export const statusChangeSchema = z.object({ status: z.enum(RECORD_STATUSES), confirmInUse: z.boolean().default(false) })
export type StatusChange = z.infer<typeof statusChangeSchema>

/** 24-hour "HH:MM", India local time. */
export const timeField = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use a time like 06:30.')

/** One thing that depends on a record: how many, and a few names to show the admin. */
export type Usage = { label: string; count: number; examples: string[] }

export const pageQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  status: z.enum(RECORD_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type PageQuery = z.infer<typeof pageQuerySchema>

/** Makes `%`, `_` and `\` in what staff typed match literally in a LIKE search. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, character => `\\${character}`)}%`

/** The server's own check, repeated on every switch-off: in-use records need an explicit yes. */
export function assertCanDeactivate(usages: Usage[], change: StatusChange, noun: string): void {
  if (change.status !== 'inactive') return
  const inUse = usages.filter(usage => usage.count > 0)
  if (inUse.length > 0 && !change.confirmInUse) {
    throw new AppError(409, 'IN_USE', `This ${noun} is still used. Confirm to switch it off; existing links stay visible as inactive.`, inUse)
  }
}

export const nameTakenError = () => new AppError(409, 'NAME_TAKEN', 'This name is already used. Choose a different name.')
export const notFoundError = (code: string, noun: string) => new AppError(404, code, `That ${noun} does not exist.`)

/** Postgres "unique violation": two admins saved the same name at the same moment. */
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'

/** Runs a save; if the database's unique index rejects a same-moment duplicate name, reports it as "name taken". */
export async function guardUnique<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) { throw isUniqueViolation(error) ? nameTakenError() : error }
}

/** Deleting is only for records nothing refers to. Anything in use must be deactivated instead. */
export function assertCanDelete(usages: Usage[], noun: string): void {
  const inUse = usages.filter(usage => usage.count > 0)
  if (inUse.length > 0) throw new AppError(409, 'IN_USE', `This ${noun} is used, so it cannot be deleted. Deactivate it instead.`, inUse)
}

/** Postgres "foreign key violation": something started using the record between the check and the delete. */
export async function guardDelete<T>(work: () => Promise<T>, noun: string): Promise<T> {
  try { return await work() } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503') throw new AppError(409, 'IN_USE', `This ${noun} is used, so it cannot be deleted. Deactivate it instead.`)
    throw error
  }
}
