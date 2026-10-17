import { createApp } from './app.js'
import { loadEnv } from './config/env.js'
import { createPool } from './db/pool.js'
import { startRecurringJob } from './jobs/recurring-job.js'
import { createRoutes } from './routes.js'

const env = loadEnv()
const pool = env.DATABASE_URL ? createPool(env.DATABASE_URL, env) : undefined
const routes = pool ? createRoutes({ env, database: pool }) : undefined
const app = createApp({ env, database: pool, routes })

const logJob = ({ level, ...entry }: { level: 'info' | 'error'; message: string; [key: string]: unknown }) => (level === 'error' ? console.error : console.log)(JSON.stringify({ level, ...entry }))

/**
 * The payment safety net: shortly after start-up and then every minute, ask PhonePe about payments still pending (the app was
 * closed mid-payment, the network dropped, or no webhook arrived, which is always the case on a laptop). Settling is safe to repeat.
 */
const stopPaymentCheck = routes
  ? startRecurringJob({ name: 'Payment background check', run: routes.reconcilePayments, firstRunMs: 20_000, intervalMs: 60_000, timeoutMs: 45_000, log: logJob })
  : undefined

/**
 * The subscription delivery job: every few minutes, make the orders for the coming days of every active subscription, so
 * production planning, the Deliveries page and tracking see them. Safe to repeat: a delivery that already has its order is left alone.
 */
const stopDeliveryJob = routes
  ? startRecurringJob({ name: 'Subscription delivery job', run: routes.generateDeliveries, firstRunMs: 30_000, intervalMs: 5 * 60_000, timeoutMs: 4 * 60_000, log: logJob })
  : undefined

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`ShreeRam Milks API listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV}${pool ? ', database configured' : ', no database configured'})`)
})
// Slow or stalled clients must not hold connections open. The keep-alive time is longer than the AWS load balancer's
// 60 second idle timeout, so the balancer never reuses a connection this server has already closed.
server.requestTimeout = 30_000
server.headersTimeout = 20_000
server.keepAliveTimeout = 65_000

/** Finish in-flight requests, then close the database pool, so a deploy or Ctrl+C never drops a half-written request. */
function shutdown(signal: string, exitCode = 0) {
  console.log(`${signal} received, shutting down`)
  stopPaymentCheck?.()
  stopDeliveryJob?.()
  server.close(() => { void (pool?.end() ?? Promise.resolve()).finally(() => process.exit(exitCode)) })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
// After an unexpected failure the process state can no longer be trusted: log it and restart cleanly.
process.on('uncaughtException', error => { console.error('Uncaught exception:', error); shutdown('uncaughtException', 1) })
process.on('unhandledRejection', reason => { console.error('Unhandled rejection:', reason); shutdown('unhandledRejection', 1) })
