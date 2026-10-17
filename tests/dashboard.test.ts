import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { adminGet, adminSignedIn } from './checkout-helpers.js'
import { ADMIN_ORIGIN, createTestApi } from './fakes.js'

describe('the dashboard', () => {
  it('gives staff the roll-up for the India day, and nobody else', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/dashboard').set('Origin', ADMIN_ORIGIN)).status).toBe(401)
    const cookie = await adminSignedIn(api)
    // 20:00 UTC on the 10th is already 01:30 on the 11th in India: the dashboard must follow the India day.
    api.clock.set('2026-10-10T20:00:00.000Z')
    const response = await adminGet(api, cookie, '/admin/dashboard')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(api.dashboardCalls.at(-1)).toEqual({ today: '2026-10-11', tomorrow: '2026-10-12' })
    expect(response.body).toMatchObject({
      today: '2026-10-11', tomorrow: '2026-10-12', deliveries: { todayTotal: 6, tomorrowTotal: 9 }, plans: { subscriptions: 4, trials: 2 },
      money: { owedPaise: 125_000, refundsToSend: 1 }, attention: { creditLimitSkips: 1, openTickets: 2 },
    })
  })
})
