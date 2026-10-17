import type { RequestHandler } from 'express'
import { AppError } from '../../http/errors.js'
import type { AuthService, SignedInAdmin } from './service.js'

export const SESSION_COOKIE = 'sr_admin_session'

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireAdmin` once the session cookie is checked. */
    admin?: SignedInAdmin
  }
}

/** Reads one cookie by name from the request, without pulling in a cookie package. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Blocks cross-site form posts and scripts from using a signed-in admin's cookie. Any request that changes
 * something must come from one of the listed admin origins. Browsers always send the Origin header on such requests.
 */
export function requireTrustedOrigin(allowedOrigins: string[]): RequestHandler {
  return (request, _response, next) => {
    if (SAFE_METHODS.has(request.method)) return next()
    const origin = request.headers.origin
    if (!origin || !allowedOrigins.includes(origin)) return next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This request did not come from the admin site.'))
    next()
  }
}

/** Lets a request through only if it carries a valid admin session. */
export function requireAdmin(auth: AuthService): RequestHandler {
  return async (request, _response, next) => {
    const admin = await auth.authenticate(readCookie(request.headers.cookie, SESSION_COOKIE))
    if (!admin) return next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in.'))
    request.admin = admin
    next()
  }
}
