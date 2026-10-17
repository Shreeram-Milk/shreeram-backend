import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const send = (api: TestApi, cookie: string, method: 'post' | 'put' | 'patch', path: string, body: object = {}) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)

/** A finished onboarding picture, ready to attach to a slide. */
async function picture(api: TestApi, cookie: string): Promise<string> {
  const started = await send(api, cookie, 'post', '/admin/media/uploads', { purpose: 'onboarding', contentType: 'image/webp', sizeBytes: 500 })
  const id = started.body.asset.id as string
  api.storage.store(api.media.rows.find(row => row.id === id)?.objectKey as string, { sizeBytes: 500, contentType: 'image/webp' })
  await send(api, cookie, 'post', `/admin/media/${id}/complete`)
  return id
}
const slide = (imageAssetId: string, extra: object = {}) => ({ imageAssetId, titleEn: 'Fresh milk', descriptionEn: 'Delivered before 7 AM', ...extra })

describe('onboarding slides', () => {
  it('needs a signed-in admin from the admin site, but the public list needs nobody', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/onboarding')).status).toBe(401)
    expect((await request(api.app).post('/admin/onboarding').set('Origin', ADMIN_ORIGIN).send({})).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post('/admin/onboarding').set('Cookie', cookie).set('Origin', 'https://evil.example').send({})
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect((await request(api.app).get('/public/onboarding')).status).toBe(200)
  })
  it('creates numbered slides, each with its own picture link, and the app sees only active ones in order', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const first = await send(api, cookie, 'post', '/admin/onboarding', slide(await picture(api, cookie), { titleEn: 'One' }))
    const second = await send(api, cookie, 'post', '/admin/onboarding', slide(await picture(api, cookie), { titleEn: 'Two', titleGu: 'બે' }))
    await send(api, cookie, 'post', '/admin/onboarding', slide(await picture(api, cookie), { titleEn: 'Hidden', status: 'inactive' }))
    expect([first.status, first.body.slide.sortOrder, second.body.slide.sortOrder]).toEqual([201, 1, 2])
    expect(first.body.slide.imageUrl).toMatch(/^https:\/\/files\.test\/onboarding\//)
    expect(first.body.slide.imageKey).toBeUndefined()
    const published = (await request(api.app).get('/public/onboarding')).body.slides as Array<{ titleEn: string }>
    expect(published.map(item => item.titleEn)).toEqual(['One', 'Two'])
    expect(Object.keys(published[0] ?? {}).sort()).toEqual(['descriptionEn', 'descriptionGu', 'id', 'imageUrl', 'sortOrder', 'titleEn', 'titleGu'])
  })
  it('requires a finished onboarding picture, a headline and text', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const banner = (await send(api, cookie, 'post', '/admin/media/uploads', { purpose: 'banner', contentType: 'image/webp', sizeBytes: 500 })).body.asset.id as string
    const pending = (await send(api, cookie, 'post', '/admin/media/uploads', { purpose: 'onboarding', contentType: 'image/webp', sizeBytes: 500 })).body.asset.id as string
    for (const body of [slide(banner), slide(pending), slide('not-a-uuid'), slide(await picture(api, cookie), { titleEn: '  ' }), slide(await picture(api, cookie), { descriptionEn: '' })]) {
      const response = await send(api, cookie, 'post', '/admin/onboarding', body)
      expect([response.status, response.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    }
    expect(api.onboarding.rows).toHaveLength(0)
  })
  it('allows five active slides at most, whether adding, switching on or editing', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const ids: string[] = []
    for (let count = 0; count < 5; count += 1) ids.push((await send(api, cookie, 'post', '/admin/onboarding', slide(await picture(api, cookie)))).body.slide.id as string)
    const sixth = await send(api, cookie, 'post', '/admin/onboarding', slide(await picture(api, cookie)))
    expect([sixth.status, sixth.body.error.code]).toEqual([409, 'ONBOARDING_LIMIT'])
    expect((await send(api, cookie, 'put', `/admin/onboarding/${ids[0]}`, slide(await picture(api, cookie), { titleEn: 'Edited' }))).status).toBe(200)
    const spare = await send(api, cookie, 'post', '/admin/onboarding', slide(await picture(api, cookie), { status: 'inactive' }))
    expect((await send(api, cookie, 'patch', `/admin/onboarding/${spare.body.slide.id}/status`, { status: 'active' })).body.error.code).toBe('ONBOARDING_LIMIT')
    await send(api, cookie, 'patch', `/admin/onboarding/${ids[1]}/status`, { status: 'inactive' })
    expect((await send(api, cookie, 'patch', `/admin/onboarding/${spare.body.slide.id}/status`, { status: 'active' })).status).toBe(200)
  })
  it('moves a slide up or down and keeps the numbers 1, 2, 3', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const ids: string[] = []
    for (const title of ['A', 'B', 'C']) ids.push((await send(api, cookie, 'post', '/admin/onboarding', slide(await picture(api, cookie), { titleEn: title }))).body.slide.id as string)
    const down = await send(api, cookie, 'post', `/admin/onboarding/${ids[0]}/move`, { direction: 'down' })
    expect(down.body.slides.map((item: { titleEn: string; sortOrder: number }) => [item.titleEn, item.sortOrder])).toEqual([['B', 1], ['A', 2], ['C', 3]])
    const top = await send(api, cookie, 'post', `/admin/onboarding/${ids[1]}/move`, { direction: 'up' })
    expect(top.body.slides.map((item: { titleEn: string }) => item.titleEn)).toEqual(['B', 'A', 'C'])
    expect((await send(api, cookie, 'post', '/admin/onboarding/6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f/move', { direction: 'up' })).body.error.code).toBe('SLIDE_NOT_FOUND')
  })
  it('answers an unknown slide with 404 and a malformed id with 400', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await request(api.app).get('/admin/onboarding/6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f').set('Cookie', cookie)).body.error.code).toBe('SLIDE_NOT_FOUND')
    expect((await request(api.app).get('/admin/onboarding/nope').set('Cookie', cookie)).body.error.code).toBe('VALIDATION_ERROR')
  })
})
