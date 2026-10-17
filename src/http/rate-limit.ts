import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'

export type RateLimitSettings = { windowMs: number; limit: number }

/**
 * Limits how often one client address may call the API. Over the limit, the client gets a stable
 * `RATE_LIMITED` error and a `Retry-After` header. Stricter limiters (for sign-in and OTP) reuse this later.
 * The counters live in memory, which is enough for one server; a shared store is needed if the API ever runs on several.
 */
export function createRateLimiter({ windowMs, limit }: RateLimitSettings): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_request, response) => { response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } }) },
  })
}
