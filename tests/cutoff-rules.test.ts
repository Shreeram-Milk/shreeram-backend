import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}
const send = (api: TestApi, cookie: string, method: 'post' | 'put' | 'patch', path: string, body: object) => request(api.app)[method](path).set('Cookie', cookie).set('Origin', ADMIN_ORIGIN).send(body)

async function twoSlots(api: TestApi, cookie: string) {
  const morning = (await send(api, cookie, 'post', '/admin/delivery-slots', { name: 'Morning', startTime: '05:00', endTime: '07:00' })).body.slot.id as string
  const evening = (await send(api, cookie, 'post', '/admin/delivery-slots', { name: 'Evening', startTime: '17:00', endTime: '19:00' })).body.slot.id as string
  return { morning, evening }
}
const rule = (slots: { morning: string; evening: string }, extra: object = {}) => ({
  name: 'Standard milk',
  conditions: [{ deliverySlotId: slots.morning, dayRelation: 'previous_day', cutoffTime: '21:00' }, { deliverySlotId: slots.evening, dayRelation: 'same_day', cutoffTime: '11:00' }],
  ...extra,
})

describe('cut-off rules (admin)', () => {
  it('needs a signed-in admin from the admin site', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/cutoff-rules')).status).toBe(401)
    const cookie = await signedIn(api)
    const foreign = await request(api.app).post('/admin/cutoff-rules').set('Cookie', cookie).set('Origin', 'https://evil.example').send({})
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
  })

  it('creates a rule with one condition per slot, reads it back and edits it, with audit entries', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const slots = await twoSlots(api, cookie)
    const created = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots))
    expect(created.status).toBe(201)
    expect(created.body.rule).toMatchObject({ name: 'Standard milk', status: 'active', description: '' })
    expect(created.body.rule.conditions).toHaveLength(2)
    const id = created.body.rule.id as string
    expect((await request(api.app).get(`/admin/cutoff-rules/${id}`).set('Cookie', cookie)).body.rule.conditions[0]).toMatchObject({ dayRelation: 'previous_day', cutoffTime: '21:00' })
    const edited = await send(api, cookie, 'put', `/admin/cutoff-rules/${id}`, rule(slots, { conditions: [{ deliverySlotId: slots.morning, dayRelation: 'same_day', cutoffTime: '04:00' }] }))
    expect(edited.body.rule.conditions).toEqual([{ deliverySlotId: slots.morning, dayRelation: 'same_day', cutoffTime: '04:00', cancelDayRelation: null, cancelTime: null }])
    expect(api.audit.map(entry => entry.action)).toEqual(expect.arrayContaining(['cutoff_rule_created', 'cutoff_rule_updated']))
  })

  it('keeps an earlier cancel deadline per slot, and refuses one after the cut-off or half filled in', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const slots = await twoSlots(api, cookie)
    const withCancel = { deliverySlotId: slots.morning, dayRelation: 'previous_day', cutoffTime: '15:00', cancelDayRelation: 'previous_day', cancelTime: '12:00' }
    const created = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { conditions: [withCancel] }))
    expect(created.status).toBe(201)
    expect(created.body.rule.conditions[0]).toMatchObject({ cancelDayRelation: 'previous_day', cancelTime: '12:00' })
    const later = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { name: 'Later', conditions: [{ ...withCancel, cancelDayRelation: 'same_day', cancelTime: '05:00' }] }))
    expect([later.status, later.body.error.details[0].message]).toEqual([400, 'Cancelling must close at or before the order cut-off.'])
    const half = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { name: 'Half', conditions: [{ ...withCancel, cancelTime: null }] }))
    expect(half.status).toBe(400)
  })

  it('refuses no conditions, a repeated slot, a bad time or day, and slots that do not exist', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const slots = await twoSlots(api, cookie)
    const none = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { conditions: [] }))
    expect([none.status, none.body.error.details[0].field]).toEqual([400, 'conditions'])
    const twice = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { conditions: [{ deliverySlotId: slots.morning, dayRelation: 'same_day', cutoffTime: '04:00' }, { deliverySlotId: slots.morning, dayRelation: 'previous_day', cutoffTime: '20:00' }] }))
    expect([twice.status, twice.body.error.details[0].message]).toEqual([400, 'Each delivery slot can only appear once.'])
    const bad = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { conditions: [{ deliverySlotId: slots.morning, dayRelation: 'next_week', cutoffTime: '24:00' }] }))
    expect(bad.body.error.details.map((issue: { field: string }) => issue.field).sort()).toEqual(['conditions.0.cutoffTime', 'conditions.0.dayRelation'])
    const missing = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { conditions: [{ deliverySlotId: '6f1c2d3e-0000-4000-8000-000000000000', dayRelation: 'same_day', cutoffTime: '04:00' }] }))
    expect([missing.status, missing.body.error.details[0].field]).toEqual([400, 'conditions.0.deliverySlotId'])
    expect(api.cutoffRules.rows).toHaveLength(0)
  })

  it('refuses a same-day cut-off that falls after the slot has started', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const slots = await twoSlots(api, cookie)
    const late = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { conditions: [{ deliverySlotId: slots.morning, dayRelation: 'same_day', cutoffTime: '06:00' }] }))
    expect([late.status, late.body.error.details[0].field]).toEqual([400, 'conditions.0.cutoffTime'])
    const atStart = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { conditions: [{ deliverySlotId: slots.morning, dayRelation: 'same_day', cutoffTime: '05:00' }] }))
    expect(atStart.status).toBe(201)
  })

  it('refuses to move a slot start earlier than a same-day order-by time that depends on it', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const slots = await twoSlots(api, cookie)
    // Evening starts at 17:00 and this rule closes ordering for it at 11:00 on the same day.
    expect((await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots))).status).toBe(201)
    const tooEarly = await send(api, cookie, 'put', `/admin/delivery-slots/${slots.evening}`, { name: 'Evening', startTime: '10:00', endTime: '19:00' })
    expect(tooEarly.status).toBe(400)
    expect(tooEarly.body.error.details[0]).toMatchObject({ field: 'startTime' })
    expect(tooEarly.body.error.details[0].message).toContain('Standard milk')
    const fine = await send(api, cookie, 'put', `/admin/delivery-slots/${slots.evening}`, { name: 'Evening', startTime: '11:30', endTime: '19:00' })
    expect(fine.status).toBe(200)
    // Changing only the name or end time never triggers the check.
    const renamed = await send(api, cookie, 'put', `/admin/delivery-slots/${slots.evening}`, { name: 'Late evening', startTime: '11:30', endTime: '20:00' })
    expect(renamed.status).toBe(200)
  })

  it('lets a rule keep a slot that was switched off later, but refuses to add one', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const slots = await twoSlots(api, cookie)
    const id = (await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots))).body.rule.id as string
    // The rule has no in-use link to block the slot's switch-off here, so the slot goes inactive.
    await send(api, cookie, 'patch', `/admin/delivery-slots/${slots.evening}/status`, { status: 'inactive' })
    expect((await send(api, cookie, 'put', `/admin/cutoff-rules/${id}`, rule(slots, { description: 'Still fine' }))).status).toBe(200)
    const another = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { name: 'Second' }))
    expect([another.status, another.body.error.details[0].message]).toEqual([400, 'Choose an active slot.'])
  })

  it('refuses a repeated name, and asks for a confirmation before switching off a rule that profiles use', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const slots = await twoSlots(api, cookie)
    const id = (await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots))).body.rule.id as string
    const again = await send(api, cookie, 'post', '/admin/cutoff-rules', rule(slots, { name: ' STANDARD MILK ' }))
    expect([again.status, again.body.error.code]).toEqual([409, 'NAME_TAKEN'])

    api.cutoffRules.productsByRule.set(id, ['Gandhinagar milk'])
    const blocked = await send(api, cookie, 'patch', `/admin/cutoff-rules/${id}/status`, { status: 'inactive' })
    expect([blocked.status, blocked.body.error.code, blocked.body.error.details[0].examples]).toEqual([409, 'IN_USE', ['Gandhinagar milk']])
    const viaForm = await send(api, cookie, 'put', `/admin/cutoff-rules/${id}`, rule(slots, { status: 'inactive' }))
    expect(viaForm.body.error.code).toBe('IN_USE')
    expect((await send(api, cookie, 'patch', `/admin/cutoff-rules/${id}/status`, { status: 'inactive', confirmInUse: true })).body.rule.status).toBe('inactive')
  })
})
