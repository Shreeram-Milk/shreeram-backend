import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { pino } from 'pino'
import { randomUUID } from 'node:crypto'
import type { Env } from './config/env.js'
import type { Database } from './db/pool.js'
import { errorHandler, notFound } from './http/errors.js'
import { createRateLimiter } from './http/rate-limit.js'

export type AppDependencies = {
  env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'CORS_ORIGINS' | 'RATE_LIMIT_PER_MINUTE'>
  database?: Database
  /** Where log lines go. Defaults to the console; tests pass a stream to inspect them. */
  logStream?: NodeJS.WritableStream
  /** Mounts feature routes (catalogue, orders, ...). They run after the shared protections and before the 404 handler. */
  routes?: (app: Express) => void
}

/**
 * Builds the Express app. Everything it needs comes in as arguments, so tests can build one without a real
 * database and the same function serves production.
 */
export function createApp({ env, database, routes, logStream }: AppDependencies): Express {
  const app = express()
  const logger = pino({ level: env.LOG_LEVEL }, logStream)

  app.disable('x-powered-by')
  // Behind the AWS load balancer the real client address is in X-Forwarded-For. One hop is trusted, so rate limits
  // see the customer and not the balancer, and a client cannot fake the header.
  app.set('trust proxy', 1)
  app.use(pinoHttp({
    logger,
    // One short line per request: no headers (they carry tokens and cookies) and no query string (it can carry codes).
    serializers: {
      req: request => ({ id: request.id, method: request.method, path: String(request.url).split('?')[0] }),
      res: response => ({ statusCode: response.statusCode }),
    },
    customLogLevel: (_request, response) => response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
    customSuccessMessage: (request, response) => `${request.method} ${String(request.url).split('?')[0]} ${response.statusCode}`,
    customErrorMessage: (request, response) => `${request.method} ${String(request.url).split('?')[0]} ${response.statusCode}`,
    genReqId: (request, response) => {
      const supplied = request.headers['x-request-id']?.toString()
      // Keep a caller-supplied id only if it is short and plain, so logs cannot be polluted through it.
      const id = supplied && /^[\w-]{8,64}$/.test(supplied) ? supplied : randomUUID()
      response.setHeader('X-Request-Id', id)
      return id
    },
  }))
  app.use(helmet())
  // Responses can hold personal data, so browsers and proxies must never cache them.
  app.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next() })
  // Browsers are limited to the listed origins. Requests with no Origin (the mobile app, curl) are not browser requests.
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || env.CORS_ORIGINS.includes(origin)), credentials: true }))
  // Health checks stay outside the limiter so a busy client can never make the load balancer think the API is down.
  app.get('/health', (_request, response) => { response.json({ status: 'ok' }) })
  app.use(createRateLimiter({ windowMs: 60_000, limit: env.RATE_LIMIT_PER_MINUTE }))
  app.use(express.json({ limit: '100kb' }))

  /** Readiness: the database answers. Returns 503 when it is not configured or not reachable. */
  app.get('/health/db', async (request, response) => {
    if (!database) { response.status(503).json({ status: 'unavailable', reason: 'DATABASE_NOT_CONFIGURED' }); return }
    try {
      await database.query('select 1')
      response.json({ status: 'ok' })
    } catch (error) {
      request.log.error({ err: error }, 'Database health check failed')
      response.status(503).json({ status: 'unavailable', reason: 'DATABASE_UNREACHABLE' })
    }
  })

  routes?.(app)
  app.use(notFound)
  app.use(errorHandler)
  return app
}
