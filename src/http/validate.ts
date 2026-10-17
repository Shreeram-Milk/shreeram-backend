import type { RequestHandler } from 'express'
import type { ZodType } from 'zod'
import { AppError } from './errors.js'

type Source = 'body' | 'query' | 'params'

/** What a client is told about a rejected field: where it is and a short reason, never the value they sent. */
export type FieldIssue = { field: string; message: string }

export class ValidationError extends AppError {
  constructor(issues: FieldIssue[]) { super(400, 'VALIDATION_ERROR', 'The request is not valid.', issues) }
}

/**
 * Checks one part of the request against a Zod schema and replaces it with the parsed result, so handlers only ever
 * see data of the right shape (trimmed, converted, with unknown fields dropped). Every external input goes through this.
 */
export function validate<Output>(source: Source, schema: ZodType<Output>): RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse(request[source])
    if (!result.success) return next(new ValidationError(result.error.issues.map(issue => ({ field: issue.path.join('.') || source, message: issue.message }))))
    // Express 5 exposes `query` as a getter, so the parsed value is defined over it instead of assigned.
    Object.defineProperty(request, source, { value: result.data, writable: true, configurable: true, enumerable: true })
    next()
  }
}
