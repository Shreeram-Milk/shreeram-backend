import request from 'supertest'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDependencies } from '../src/app.js'
import { validate } from '../src/http/validate.js'

const env = { NODE_ENV: 'test' as const, LOG_LEVEL: 'silent' as const, CORS_ORIGINS: ['http://localhost:3000'], RATE_LIMIT_PER_MINUTE: 1000 }
const build = (overrides: Partial<AppDependencies> = {}) => createApp({ env, ...overrides })

describe('health', () => {
  it('reports the process is up without touching the database', async () => {
    const response = await request(build()).get('/health')
    expect([response.status, response.body]).toEqual([200, { status: 'ok' }])
  })
  it('reports the database is unavailable when it is not configured', async () => {
    const response = await request(build()).get('/health/db')
    expect([response.status, response.body]).toEqual([503, { status: 'unavailable', reason: 'DATABASE_NOT_CONFIGURED' }])
  })
  it('reports ok when the database answers, and unreachable without leaking the error', async () => {
    const good = await request(build({ database: { query: vi.fn().mockResolvedValue({ rows: [] }) } as never })).get('/health/db')
    expect([good.status, good.body]).toEqual([200, { status: 'ok' }])
    const bad = await request(build({ database: { query: vi.fn().mockRejectedValue(new Error('password authentication failed for user "shreeram_app"')) } as never })).get('/health/db')
    expect(bad.status).toBe(503)
    expect(JSON.stringify(bad.body)).not.toMatch(/password|shreeram_app/)
    expect(bad.body.reason).toBe('DATABASE_UNREACHABLE')
  })
})

describe('errors', () => {
  it('answers an unknown route with a stable error code', async () => {
    const response = await request(build()).get('/nope')
    expect([response.status, response.body.error.code]).toEqual([404, 'NOT_FOUND'])
  })
  it('answers malformed JSON with 400 and an oversized body with 413', async () => {
    const app = build()
    const malformed = await request(app).post('/anything').set('Content-Type', 'application/json').send('{bad')
    expect([malformed.status, malformed.body.error.code]).toEqual([400, 'INVALID_JSON'])
    const large = await request(app).post('/anything').set('Content-Type', 'application/json').send(JSON.stringify({ text: 'x'.repeat(200_000) }))
    expect([large.status, large.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE'])
  })
  it('turns an unexpected failure, even in an async handler, into a generic 500 that leaks nothing', async () => {
    const app = build({ routes: router => {
      router.get('/boom', () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2') })
      router.get('/async-boom', async () => { await Promise.resolve(); throw new Error('SELECT * FROM secrets failed') })
    } })
    for (const path of ['/boom', '/async-boom']) {
      const response = await request(app).get(path)
      expect([response.status, response.body.error.code, response.body.error.message]).toEqual([500, 'INTERNAL_ERROR', 'Something went wrong.'])
      expect(JSON.stringify(response.body)).not.toMatch(/ECONNREFUSED|hunter2|SELECT|secrets|stack/i)
    }
  })
})

describe('security headers, caching and request ids', () => {
  it('sets standard security headers, hides the framework and forbids caching', async () => {
    const response = await request(build()).get('/health')
    expect(response.headers['x-powered-by']).toBeUndefined()
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['cache-control']).toBe('no-store')
  })
  it('returns a request id, keeps a plain one from the caller and replaces anything odd', async () => {
    const app = build()
    expect((await request(app).get('/health')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect((await request(app).get('/health').set('X-Request-Id', 'abc-12345')).headers['x-request-id']).toBe('abc-12345')
    expect((await request(app).get('/health').set('X-Request-Id', 'bad id with spaces!')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('CORS', () => {
  it('allows a listed browser origin, refuses others, and lets requests with no origin through', async () => {
    const app = build()
    const allowed = await request(app).get('/health').set('Origin', 'http://localhost:3000')
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    const refused = await request(app).get('/health').set('Origin', 'https://evil.example')
    expect(refused.headers['access-control-allow-origin']).toBeUndefined()
    expect((await request(app).get('/health')).status).toBe(200)
  })
})

describe('rate limiting', () => {
  it('stops a client that goes over the limit with a stable error, and tells it when to retry', async () => {
    const app = build({ env: { ...env, RATE_LIMIT_PER_MINUTE: 3 }, routes: router => { router.get('/ping', (_request, response) => { response.json({ ok: true }) }) } })
    const statuses: number[] = []
    for (let index = 0; index < 5; index += 1) statuses.push((await request(app).get('/ping')).status)
    expect(statuses).toEqual([200, 200, 200, 429, 429])
    const blocked = await request(app).get('/ping')
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.headers['retry-after']).toBeDefined()
  })
  it('never limits the health check, so the load balancer is not told the API is down', async () => {
    const app = build({ env: { ...env, RATE_LIMIT_PER_MINUTE: 3 } })
    for (let index = 0; index < 10; index += 1) expect((await request(app).get('/health')).status).toBe(200)
  })
})

describe('validation', () => {
  const body = z.object({ name: z.string().trim().min(1), quantity: z.coerce.number().int().min(1).max(50) })
  const app = build({ routes: router => {
    router.post('/echo', validate('body', body), (request, response) => { response.json(request.body) })
    router.get('/search', validate('query', z.object({ page: z.coerce.number().int().min(1).default(1) })), (request, response) => { response.json(request.query) })
  } })

  it('passes a valid body through cleaned: trimmed, converted, and with unknown fields dropped', async () => {
    const response = await request(app).post('/echo').send({ name: '  Milk ', quantity: '3', isAdmin: true })
    expect([response.status, response.body]).toEqual([200, { name: 'Milk', quantity: 3 }])
  })
  it('rejects bad input with field-level reasons and never echoes the values sent', async () => {
    const response = await request(app).post('/echo').send({ name: '', quantity: 99, secret: 'do-not-echo' })
    expect([response.status, response.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    expect(response.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['name', 'quantity'])
    expect(JSON.stringify(response.body)).not.toMatch(/do-not-echo|99/)
  })
  it('rejects a body that is missing entirely and applies defaults to the query', async () => {
    expect((await request(app).post('/echo')).status).toBe(400)
    expect((await request(app).get('/search')).body).toEqual({ page: 1 })
    expect((await request(app).get('/search?page=abc')).status).toBe(400)
  })
})

describe('logging', () => {
  it('writes one short line per request and never records headers, cookies or the query string', async () => {
    const lines: string[] = []
    const logStream = { write: (line: string) => { lines.push(line); return true } } as unknown as NodeJS.WritableStream
    const app = build({ env: { ...env, LOG_LEVEL: 'info' }, logStream })
    await request(app).get('/health?code=123456&token=super-secret-token').set('Authorization', 'Bearer abc.def.ghi').set('Cookie', 'session=top-secret-cookie')
    const log = lines.join('')
    expect(log).toMatch(/GET \/health 200/)
    expect(log).not.toMatch(/123456|super-secret-token|abc\.def\.ghi|top-secret-cookie|authorization|cookie|headers/i)
  })
  it('logs client errors as warnings and server errors as errors', async () => {
    const lines: string[] = []
    const logStream = { write: (line: string) => { lines.push(line); return true } } as unknown as NodeJS.WritableStream
    const app = build({ env: { ...env, LOG_LEVEL: 'info' }, logStream, routes: router => { router.get('/boom', () => { throw new Error('x') }) } })
    await request(app).get('/missing')
    await request(app).get('/boom')
    const levels = lines.map(line => (JSON.parse(line) as { level: number; res?: { statusCode: number } })).filter(entry => entry.res).map(entry => [entry.res?.statusCode, entry.level])
    expect(levels).toContainEqual([404, 40])
    expect(levels).toContainEqual([500, 50])
  })
})
