import type { ErrorRequestHandler, RequestHandler } from 'express'

/**
 * An error the client should see. The `code` is stable (the apps translate it into their own wording); the
 * message is only a fallback for logs and developers. `details` carries safe extra facts such as which fields failed.
 */
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message) }
}

export const notFound: RequestHandler = (request, _response, next) => next(new AppError(404, 'NOT_FOUND', `No route for ${request.method} ${request.path}`))

const typeOf = (error: unknown): string | undefined => typeof error === 'object' && error !== null && 'type' in error ? String((error as { type?: unknown }).type) : undefined

/** Turns every failure into `{ error: { code, message } }`. Unexpected errors are logged in full and shown as a generic message. */
export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  if (error instanceof AppError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } })
    return
  }
  if (typeOf(error) === 'entity.parse.failed') {
    response.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } })
    return
  }
  if (typeOf(error) === 'entity.too.large') {
    response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' } })
    return
  }
  request.log.error({ err: error }, 'Unhandled error')
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } })
}
