import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createTtlCache } from '../src/http/ttl-cache.js'
import { ADMIN_ORIGIN, DEFAULT_SETTINGS, PASSWORD, createTestApi, type TestApi } from './fakes.js'

describe('short-lived cache', () => {
  it('asks the source once while fresh, again after it expires, and again for a different key', async () => {
    let clock = 0
    const cache = createTtlCache<string>(1000, () => clock)
    const load = vi.fn(async () => 'answer')
    await cache.get('a', load)
    await cache.get('a', load)
    expect(load).toHaveBeenCalledTimes(1)
    clock = 999
    await cache.get('a', load)
    expect(load).toHaveBeenCalledTimes(1)
    clock = 1001
    await cache.get('a', load)
    expect(load).toHaveBeenCalledTimes(2)
    await cache.get('b', load)
    expect(load).toHaveBeenCalledTimes(3)
  })
  it('shares one fetch between callers who ask at the same moment', async () => {
    const cache = createTtlCache<number>(1000)
    let resolve: (value: number) => void = () => undefined
    const load = vi.fn(() => new Promise<number>(done => { resolve = done }))
    const callers = Promise.all([cache.get('a', load), cache.get('a', load), cache.get('a', load)])
    resolve(7)
    expect(await callers).toEqual([7, 7, 7])
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('never remembers a failure, and forgets on clear', async () => {
    const cache = createTtlCache<string>(1000)
    const failing = vi.fn(async () => { throw new Error('database down') })
    await expect(cache.get('a', failing)).rejects.toThrow('database down')
    const working = vi.fn(async () => 'ok')
    expect(await cache.get('a', working)).toBe('ok')
    cache.clear()
    await cache.get('a', working)
    expect(working).toHaveBeenCalledTimes(2)
  })
})

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}

describe('public endpoints are easy on the database', () => {
  it('answers many phones from one database read, and tells phones they may reuse the answer briefly', async () => {
    const api = await createTestApi({ withAdmin: false })
    const read = vi.spyOn(api.banners, 'listPublic')
    const responses = await Promise.all(Array.from({ length: 25 }, () => request(api.app).get('/public/banners')))
    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    expect(responses[0]?.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60')
  })
  it('does the same for the slides and the settings', async () => {
    const api = await createTestApi({ withAdmin: false })
    const slides = vi.spyOn(api.onboarding, 'listActive')
    const settings = vi.spyOn(api.settings, 'get')
    for (let phone = 0; phone < 10; phone += 1) {
      await request(api.app).get('/public/onboarding')
      await request(api.app).get('/public/app-settings')
    }
    expect(slides).toHaveBeenCalledTimes(1)
    expect(settings).toHaveBeenCalledTimes(1)
  })
  it('shows an admin change straight away, not after the cache runs out', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const create = (titleEn: string) => request(api.app).post('/admin/banners').set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send({ titleEn })
    await create('First')
    expect((await request(api.app).get('/public/banners')).body.banners).toHaveLength(1)
    await create('Second')
    expect((await request(api.app).get('/public/banners')).body.banners).toHaveLength(2)
    const { updatedAt: _updatedAt, ...editable } = DEFAULT_SETTINGS
    void _updatedAt
    expect((await request(api.app).get('/public/app-settings')).body.settings.maintenanceMode).toBe(false)
    await request(api.app).put('/admin/app-settings').set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send({ ...editable, maintenanceMode: true, maintenanceMessageEn: 'Back soon' })
    expect((await request(api.app).get('/public/app-settings')).body.settings.maintenanceMode).toBe(true)
  })
  it('keeps everything private or personal out of shared caches', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const admin = await request(api.app).get('/admin/banners').set('Cookie', cookie)
    expect(admin.headers['cache-control']).toBe('no-store')
    expect((await request(api.app).get('/admin/banners')).headers['cache-control']).toBe('no-store')
  })
})
