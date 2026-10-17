import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const post = (api: TestApi, cookie: string, path: string, body: object = {}) => request(api.app).post(path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
const picture = { purpose: 'banner', contentType: 'image/webp', sizeBytes: 120_000 }

/** Reserve a picture and pretend the browser sent it, so a test can start from a finished upload. */
async function finishedUpload(api: TestApi, cookie: string) {
  const started = await post(api, cookie, '/admin/media/uploads', picture)
  const id = started.body.asset.id as string
  const key = api.media.rows.find(row => row.id === id)?.objectKey as string
  api.storage.store(key, { sizeBytes: picture.sizeBytes, contentType: picture.contentType })
  await post(api, cookie, `/admin/media/${id}/complete`)
  return { id, key }
}

describe('picture uploads', () => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).post('/admin/media/uploads').set('Origin', ADMIN_ORIGIN).send(picture)).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post('/admin/media/uploads').set('Cookie', cookie).set('Origin', 'https://evil.example').send(picture)
    expect([foreign.status, foreign.body.error.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED'])
    expect(api.media.rows).toHaveLength(0)
  })
  it('hands out an upload link for the exact type and size, with a random key that ignores any file name', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const response = await post(api, cookie, '/admin/media/uploads', { ...picture, fileName: '../../secret.sh' })
    expect(response.status).toBe(201)
    expect(response.body.upload).toMatchObject({ headers: { 'Content-Type': 'image/webp' }, expiresInSeconds: 300 })
    const ticket = api.storage.tickets[0]
    expect(ticket).toMatchObject({ contentType: 'image/webp', sizeBytes: 120_000 })
    expect(ticket?.key).toMatch(/^banners\/2026\/10\/[0-9a-f-]{36}\.webp$/)
    expect(JSON.stringify(response.body)).not.toContain('secret.sh')
    expect(api.media.rows[0]?.status).toBe('pending')
  })
  it('refuses other file types, empty or oversized files, and unknown purposes', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    for (const bad of [{ contentType: 'image/svg+xml' }, { contentType: 'text/html' }, { contentType: 'application/pdf' }, { sizeBytes: 0 }, { sizeBytes: 2 * 1024 * 1024 + 1 }, { sizeBytes: 1.5 }, { purpose: 'avatar' }]) {
      const response = await post(api, cookie, '/admin/media/uploads', { ...picture, ...bad })
      expect([response.status, response.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    }
    expect(api.media.rows).toHaveLength(0)
  })
  it('marks a picture ready only after the storage really holds a file of the promised type and size', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const id = (await post(api, cookie, '/admin/media/uploads', picture)).body.asset.id as string
    const key = api.media.rows[0]?.objectKey as string
    const missing = await post(api, cookie, `/admin/media/${id}/complete`)
    expect([missing.status, missing.body.error.code]).toEqual([409, 'UPLOAD_NOT_FOUND'])
    api.storage.store(key, { sizeBytes: 999, contentType: 'image/webp' })
    expect((await post(api, cookie, `/admin/media/${id}/complete`)).body.error.code).toBe('UPLOAD_MISMATCH')
    api.storage.store(key, { sizeBytes: picture.sizeBytes, contentType: 'text/html' })
    expect((await post(api, cookie, `/admin/media/${id}/complete`)).body.error.code).toBe('UPLOAD_MISMATCH')
    expect(api.media.rows[0]?.status).toBe('pending')
    api.storage.store(key, { sizeBytes: picture.sizeBytes, contentType: 'image/webp' })
    const done = await post(api, cookie, `/admin/media/${id}/complete`)
    expect([done.status, done.body.asset]).toEqual([200, { id, status: 'ready' }])
    expect((await post(api, cookie, `/admin/media/${id}/complete`)).status).toBe(200)
    expect(api.audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['media_upload_started', 'media_upload_completed']))
  })
  it('answers an unknown or malformed picture id clearly', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await post(api, cookie, '/admin/media/6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f/complete')).body.error.code).toBe('MEDIA_NOT_FOUND')
    expect((await post(api, cookie, '/admin/media/not-a-uuid/complete')).body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('banner pictures', () => {
  const banner = { titleEn: 'Fresh milk today', messageEn: 'Delivered before 7 AM', sortOrder: 1 }

  it('shows a short-lived picture link in the admin and the app, and never the storage key', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const upload = await finishedUpload(api, cookie)
    const created = await post(api, cookie, '/admin/banners', { ...banner, imageAssetId: upload.id })
    expect(created.status).toBe(201)
    expect(created.body.banner).toMatchObject({ imageAssetId: upload.id, imageUrl: `https://files.test/${upload.key}?signed=1` })
    expect(created.body.banner.imageKey).toBeUndefined()
    const publicList = await request(api.app).get('/public/banners')
    expect(publicList.body.banners[0].imageUrl).toBe(`https://files.test/${upload.key}?signed=1`)
    expect(JSON.stringify(publicList.body)).not.toContain('imageKey')
  })
  it('refuses a picture that is not finished, does not exist, or is not a valid id', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const pending = (await post(api, cookie, '/admin/media/uploads', picture)).body.asset.id as string
    for (const imageAssetId of [pending, '6f1c3b9e-4b1a-4a55-9d0a-0a1b2c3d4e5f', 'not-a-uuid']) {
      const response = await post(api, cookie, '/admin/banners', { ...banner, imageAssetId })
      expect([response.status, response.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
    }
    expect(api.banners.rows).toHaveLength(0)
  })
  it('can replace or remove the picture, and a banner with none has a null link', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const upload = await finishedUpload(api, cookie)
    const created = (await post(api, cookie, '/admin/banners', { ...banner, imageAssetId: upload.id })).body.banner as { id: string }
    const removed = await request(api.app).put(`/admin/banners/${created.id}`).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send({ ...banner, imageAssetId: null })
    expect(removed.body.banner).toMatchObject({ imageAssetId: null, imageUrl: null })
    expect((await request(api.app).get('/public/banners')).body.banners[0].imageUrl).toBeNull()
  })
})
