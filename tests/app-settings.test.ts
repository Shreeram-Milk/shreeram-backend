import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, DEFAULT_SETTINGS, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const { updatedAt: _updatedAt, ...EDITABLE } = DEFAULT_SETTINGS
void _updatedAt
const save = (api: TestApi, cookie: string, body: object) => request(api.app).put('/admin/app-settings').set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)

describe('app settings (admin)', () => {
  it('needs a signed-in admin from the admin site, for reading and for saving', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/app-settings')).status).toBe(401)
    expect((await request(api.app).put('/admin/app-settings').set('Origin', ADMIN_ORIGIN).send(EDITABLE)).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).put('/admin/app-settings').set('Cookie', cookie).set('Origin', 'https://evil.example').send(EDITABLE)
    expect([foreign.status, foreign.body.error.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED'])
    expect(api.settings.savedBy).toHaveLength(0)
  })
  it('reads the settings and saves changes, cleaning phone numbers and recording who saved and when', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await request(api.app).get('/admin/app-settings').set('Cookie', cookie)).body.settings.minimumAppVersion).toBe('1.0.0')
    const saved = await save(api, cookie, { ...EDITABLE, supportPhone: '+91 98765-43210', callEnabled: true, supportEmail: 'help@example.com' })
    expect(saved.status).toBe(200)
    expect(saved.body.settings).toMatchObject({ supportPhone: '+919876543210', callEnabled: true, supportEmail: 'help@example.com' })
    expect(api.settings.savedBy).toEqual([api.admin?.id])
    expect(api.audit.map(entry => entry.action)).toContain('app_settings_updated')
  })
  it('keeps support numbers and messages out of the audit trail', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    await save(api, cookie, { ...EDITABLE, supportPhone: '9876543210', maintenanceMode: true, maintenanceMessageEn: 'Back at noon' })
    const entry = api.audit.find(item => item.action === 'app_settings_updated')
    expect(JSON.stringify(entry)).not.toMatch(/9876543210|Back at noon/)
    expect(entry?.details).toMatchObject({ maintenanceMode: true })
  })
  it('refuses settings the app could not use, naming the field at fault', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const cases: Array<[object, string]> = [
      [{ callEnabled: true }, 'supportPhone'],
      [{ whatsappEnabled: true }, 'supportWhatsApp'],
      [{ supportPhone: '12345' }, 'supportPhone'],
      [{ supportEmail: 'not-an-email' }, 'supportEmail'],
      [{ minimumAppVersion: '1.0' }, 'minimumAppVersion'],
      [{ maintenanceMode: true }, 'maintenanceMessageEn'],
      [{ showMaintenanceContact: true }, 'showMaintenanceContact'],
      [{ supportHoursEn: 'x'.repeat(81) }, 'supportHoursEn'],
    ]
    for (const [change, field] of cases) {
      const response = await save(api, cookie, { ...EDITABLE, ...change })
      expect([response.status, response.body.error.details.map((issue: { field: string }) => issue.field)], JSON.stringify(change)).toEqual([400, [field]])
    }
    expect(api.settings.savedBy).toHaveLength(0)
  })
  it('refuses a request that leaves out a switch, so a switch can never flip by accident', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const { flags: _flags, ...withoutFlags } = EDITABLE
    void _flags
    expect((await save(api, cookie, withoutFlags)).status).toBe(400)
    expect((await save(api, cookie, { ...EDITABLE, flags: { showTrials: false } })).status).toBe(400)
  })
  it('drops unknown fields instead of storing them', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const response = await save(api, cookie, { ...EDITABLE, isAdmin: true, updatedAt: '1999-01-01' })
    expect(response.status).toBe(200)
    expect(response.body.settings.isAdmin).toBeUndefined()
    expect(response.body.settings.updatedAt).not.toBe('1999-01-01')
  })
})

describe('app settings (what the app reads)', () => {
  it('needs no sign-in, carries every setting the app uses, and no save time', async () => {
    const api = await createTestApi({ withAdmin: false })
    const response = await request(api.app).get('/public/app-settings')
    expect(response.status).toBe(200)
    expect(Object.keys(response.body.settings).sort()).toEqual(Object.keys(EDITABLE).sort())
    expect(response.body.settings.updatedAt).toBeUndefined()
  })
  it('shows a change as soon as it is saved, including maintenance mode', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    await save(api, cookie, { ...EDITABLE, maintenanceMode: true, maintenanceMessageEn: 'Back soon', flags: { ...EDITABLE.flags, showOffers: false } })
    const response = await request(api.app).get('/public/app-settings')
    expect(response.body.settings).toMatchObject({ maintenanceMode: true, maintenanceMessageEn: 'Back soon', flags: { showOffers: false, showTrials: true } })
  })
})
