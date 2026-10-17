import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { svgProblem } from '../src/modules/media/svg.js'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const post = (api: TestApi, cookie: string, path: string, body: object = {}) => request(api.app).post(path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)
const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="#0a7"/></svg>'

/** Reserve an upload, pretend the browser sent `text`, and ask the backend to finish it. */
async function upload(api: TestApi, cookie: string, request: { purpose: string; contentType: string }, text: string, sizeBytes = text.length) {
  const started = await post(api, cookie, '/admin/media/uploads', { ...request, sizeBytes })
  const id = started.body.asset.id as string
  api.storage.store(api.media.rows.find(row => row.id === id)?.objectKey as string, { sizeBytes, contentType: request.contentType, text })
  const done = await post(api, cookie, `/admin/media/${id}/complete`)
  return { id, done }
}

describe('picture rules by purpose', () => {
  it('accepts SVG only for icons, and photos only for banners and onboarding', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const ask = (body: object) => post(api, cookie, '/admin/media/uploads', body)
    expect((await ask({ purpose: 'banner_icon', contentType: 'image/svg+xml', sizeBytes: 500 })).status).toBe(201)
    expect((await ask({ purpose: 'onboarding', contentType: 'image/webp', sizeBytes: 500 })).status).toBe(201)
    expect((await ask({ purpose: 'banner_icon', contentType: 'image/png', sizeBytes: 500 })).status).toBe(400)
    expect((await ask({ purpose: 'banner', contentType: 'image/svg+xml', sizeBytes: 500 })).status).toBe(400)
    expect((await ask({ purpose: 'onboarding', contentType: 'image/svg+xml', sizeBytes: 500 })).status).toBe(400)
  })
  it('keeps icons tiny: 100 KB at most', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await post(api, cookie, '/admin/media/uploads', { purpose: 'banner_icon', contentType: 'image/svg+xml', sizeBytes: 100 * 1024 })).status).toBe(201)
    const tooBig = await post(api, cookie, '/admin/media/uploads', { purpose: 'banner_icon', contentType: 'image/svg+xml', sizeBytes: 100 * 1024 + 1 })
    expect([tooBig.status, tooBig.body.error.details[0].message]).toEqual([400, 'Keep the icon under 100 KB.'])
  })
  it('stores onboarding pictures under their own folder', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    await post(api, cookie, '/admin/media/uploads', { purpose: 'onboarding', contentType: 'image/jpeg', sizeBytes: 900 })
    expect(api.storage.tickets[0]?.key).toMatch(/^onboarding\/2026\/10\/[0-9a-f-]{36}\.jpg$/)
  })
})

describe('SVG safety', () => {
  it('lets plain drawings through and refuses anything that can run code or load other files', () => {
    expect(svgProblem(SAFE_SVG)).toBeNull()
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
      '<svg><foreignObject><div/></foreignObject></svg>',
      '<svg><image href="https://evil.example/x.png"/></svg>',
      '<svg><rect style="fill:url(https://evil.example/x)"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
      '<svg><style>@import "https://evil.example/x.css"</style></svg>',
    ]) expect(svgProblem(bad), bad).not.toBeNull()
    expect(svgProblem('<html><body>hello</body></html>')).toBe('It is not an SVG file.')
  })
  it('finishes a safe icon and rejects an unsafe one without marking it ready', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const safe = await upload(api, cookie, { purpose: 'banner_icon', contentType: 'image/svg+xml' }, SAFE_SVG)
    expect(safe.done.status).toBe(200)
    const unsafe = await upload(api, cookie, { purpose: 'banner_icon', contentType: 'image/svg+xml' }, '<svg><script>alert(1)</script></svg>')
    expect([unsafe.done.status, unsafe.done.body.error.code]).toEqual([409, 'UNSAFE_SVG'])
    expect(api.media.rows.find(row => row.id === unsafe.id)?.status).toBe('pending')
  })
})

describe('banner pictures by type, and the label', () => {
  const banner = { titleEn: 'Heads up', sortOrder: 1 }

  it('gives each type the right kind of image: a photo for promotions, an SVG icon for notices, nothing for warnings', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const photo = await upload(api, cookie, { purpose: 'banner', contentType: 'image/webp' }, 'x', 100)
    const icon = await upload(api, cookie, { purpose: 'banner_icon', contentType: 'image/svg+xml' }, SAFE_SVG)
    const create = (body: object) => post(api, cookie, '/admin/banners', { ...banner, ...body })
    expect((await create({ type: 'promotion', imageAssetId: photo.id })).status).toBe(201)
    expect((await create({ type: 'maintenance', imageAssetId: icon.id })).status).toBe(201)
    expect((await create({ type: 'informational', imageAssetId: icon.id })).status).toBe(201)
    expect((await create({ type: 'promotion', imageAssetId: icon.id })).status).toBe(400)
    expect((await create({ type: 'maintenance', imageAssetId: photo.id })).status).toBe(400)
    const warning = await create({ type: 'warning', imageAssetId: photo.id })
    expect([warning.status, warning.body.error.details[0].field]).toEqual([400, 'imageAssetId'])
    expect((await create({ type: 'warning' })).status).toBe(201)
  })
  it('no longer accepts manual announcements', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const response = await post(api, cookie, '/admin/banners', { ...banner, type: 'announcement' })
    expect([response.status, response.body.error.code]).toEqual([400, 'VALIDATION_ERROR'])
  })
  it('keeps the label optional, limits its length, and passes it on to the app', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const plain = await post(api, cookie, '/admin/banners', banner)
    expect(plain.body.banner).toMatchObject({ labelEn: '', labelGu: '' })
    const labelled = await post(api, cookie, '/admin/banners', { ...banner, labelEn: 'SEASONAL OFFER', labelGu: 'મોસમી ઓફર' })
    expect(labelled.body.banner).toMatchObject({ labelEn: 'SEASONAL OFFER', labelGu: 'મોસમી ઓફર' })
    expect((await post(api, cookie, '/admin/banners', { ...banner, labelEn: 'x'.repeat(25) })).status).toBe(400)
    const published = (await request(api.app).get('/public/banners')).body.banners as Array<{ labelEn: string }>
    expect(published.map(item => item.labelEn).sort()).toEqual(['', 'SEASONAL OFFER'])
  })
})
