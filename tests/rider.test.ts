import { describe, expect, it } from 'vitest'
import { AppError } from '../src/http/errors.js'
import { sha256 } from '../src/modules/auth/crypto.js'
import type { NotifyInput } from '../src/modules/notifications/notifier.js'
import type { RiderSheet } from '../src/modules/production-planning/rider-sheet.js'
import type { CheckIn, NewRiderSession, RiderRepository, WaitingCustomer } from '../src/modules/rider/repository.js'
import { createRiderService, RIDER_SESSION_DAYS } from '../src/modules/rider/service.js'
import { buildRiderSheet, type RiderStopRow } from '../src/modules/production-planning/rider-sheet.js'

const SLOT = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-10-10T01:00:00.000Z') // 06:30 in India, 10 October

const stop = (orderId: string, name: string, pinCode: string, line1: string): RiderStopRow => ({
  orderId, orderNumber: `SRM-${orderId}`, recipientName: name, recipientPhone: '9999900000', addressLine1: line1, addressLine2: 'Shyam Flats', landmark: '', city: 'Ahmedabad', pinCode, doorstepNote: '', kind: 'one_time',
  items: [{ productId: 'p1', variantId: 'v1', productName: 'Cow Milk', variantName: '1 L', quantity: 1 }],
})

function setup(options: { stops?: RiderStopRow[]; waiting?: WaitingCustomer[] } = {}) {
  const sessions: Array<NewRiderSession & { revoked: boolean }> = []
  const checkIns: Array<CheckIn & { id: string }> = []
  const notified: NotifyInput[] = []
  const marked: Array<{ orderIds: string[]; status: string }> = []
  const stops = options.stops ?? [stop('1', 'Asha', '380001', 'A-1'), stop('2', 'Asha', '380001', 'A-1'), stop('3', 'Bina', '380001', 'B-2'), stop('4', 'Chirag', '380015', 'C-3')]
  const waiting = options.waiting ?? [
    { customerId: 'c-asha', orderId: '1', orderNumber: 'SRM-1' }, { customerId: 'c-bina', orderId: '3', orderNumber: 'SRM-3' },
  ]
  const repository: RiderRepository = {
    async createSession(session) { sessions.push({ ...session, revoked: false }) },
    async findSession(tokenHash, now) {
      const session = sessions.find(item => item.tokenHash === tokenHash && !item.revoked && item.expiresAt > now)
      return session ? { sessionId: tokenHash, adminId: session.adminId, email: 'owner@example.com' } : null
    },
    async touchSession() {},
    async revokeSession(tokenHash) { for (const session of sessions) if (session.tokenHash === tokenHash) session.revoked = true },
    async windows() { return [] },
    async checkIns() { return checkIns },
    async recordCheckIn({ pinCode }) {
      if (checkIns.some(entry => entry.pinCode === pinCode)) return null
      const id = `checkin-${checkIns.length + 1}`
      checkIns.push({ id, pinCode, checkedInAt: NOW.toISOString(), customersNotified: 0 })
      return id
    },
    async setNotified(id, customers) { const entry = checkIns.find(item => item.id === id); if (entry) entry.customersNotified = customers },
    async waitingCustomers() { return waiting },
    async closedStops() { return [{ orderId: '9', orderNumber: 'SRM-9', recipientName: 'Dev', addressLine1: 'D-4', addressLine2: '', pinCode: '380001', status: 'delivered' as const, closedAt: NOW.toISOString(), items: [] }] },
  }
  const service = createRiderService({
    repository,
    auth: { async startLogin() {}, async confirmCode(email) { return { id: 'admin-1', email } } },
    plans: { async riderSheetFor(date, slotId): Promise<RiderSheet> {
      return buildRiderSheet({ date, slot: { slotId, name: 'Morning', startTime: '06:00', endTime: '08:00' }, stops, closing: null, truncated: false, warnings: [], now: NOW })
    } },
    orders: { async adminBulkStatus(input) { marked.push({ orderIds: input.orderIds, status: input.status }); return { updated: input.orderIds.length, failed: [] } } },
    notifier: { async notify(input) { notified.push(input) } },
    now: () => NOW,
  })
  return { service, sessions, checkIns, notified, marked }
}

const actor = { adminId: 'admin-1', ip: null }
const context = { ip: '1.2.3.4', userAgent: 'rider-app' }

describe('rider sign-in', () => {
  it('opens a 30-day session and stores only the hash of the token', async () => {
    const { service, sessions } = setup()
    const { token, expiresAt, rider } = await service.completeLogin('owner@example.com', '123456', context)
    expect(rider.id).toBe('admin-1')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.tokenHash).toBe(sha256(token))
    expect(sessions[0]?.tokenHash).not.toBe(token)
    expect(expiresAt.getTime() - NOW.getTime()).toBe(RIDER_SESSION_DAYS * 24 * 60 * 60_000)
    expect(await service.authenticate(token)).toEqual({ id: 'admin-1', email: 'owner@example.com' })
  })

  it('rejects a missing, unknown or signed-out token', async () => {
    const { service } = setup()
    expect(await service.authenticate(undefined)).toBeNull()
    expect(await service.authenticate('not-a-real-token')).toBeNull()
    const { token } = await service.completeLogin('owner@example.com', '123456', context)
    await service.logout(token)
    expect(await service.authenticate(token)).toBeNull()
  })
})

describe('rider check-in', () => {
  it('tells each customer with an open order in the PIN once, naming the window and their order', async () => {
    const { service, notified, checkIns } = setup()
    const result = await service.checkIn({ slotId: SLOT, pinCode: '380001' }, actor)
    expect(result).toEqual({ alreadyCheckedIn: false, customersNotified: 2 })
    expect(notified.map(item => [item.event, item.customerId, item.vars.order, item.vars.window])).toEqual([
      ['rider_arriving', 'c-asha', 'SRM-1', 'Morning'], ['rider_arriving', 'c-bina', 'SRM-3', 'Morning'],
    ])
    expect(new Set(notified.map(item => item.dedupeKey)).size).toBe(2)
    expect(checkIns[0]?.customersNotified).toBe(2)
  })

  it('does not tell anyone twice when the PIN is checked in again', async () => {
    const { service, notified } = setup()
    await service.checkIn({ slotId: SLOT, pinCode: '380001' }, actor)
    const again = await service.checkIn({ slotId: SLOT, pinCode: '380001' }, actor)
    expect(again).toEqual({ alreadyCheckedIn: true, customersNotified: 2 })
    expect(notified).toHaveLength(2)
  })

  it('refuses a PIN that has no open deliveries left in the window', async () => {
    const { service, notified, checkIns } = setup()
    await expect(service.checkIn({ slotId: SLOT, pinCode: '999999' }, actor)).rejects.toMatchObject({ status: 409, code: 'NO_OPEN_ORDERS_IN_PIN' })
    expect(notified).toHaveLength(0)
    expect(checkIns).toHaveLength(0)
    await expect(service.checkIn({ slotId: SLOT, pinCode: '999999' }, actor)).rejects.toBeInstanceOf(AppError)
  })
})

describe('rider sheet and deliveries', () => {
  it('gives one stop per house with every order of that house, so they are closed together', async () => {
    const { service, marked } = setup()
    const { sheet } = await service.sheet(SLOT)
    const area = sheet.areas.find(entry => entry.pinCode === '380001')
    const house = area?.stops.find(entry => entry.recipientName === 'Asha')
    expect(house?.orderIds.sort()).toEqual(['1', '2'])
    await service.markOrders({ orderIds: house?.orderIds ?? [], status: 'delivered' }, actor)
    expect(marked).toEqual([{ orderIds: ['1', '2'], status: 'delivered' }])
  })

  it('keeps finished houses on the sheet with how each one ended', async () => {
    const { service } = setup()
    const { done } = await service.sheet(SLOT)
    expect(done).toEqual([expect.objectContaining({ orderNumber: 'SRM-9', status: 'delivered', pinCode: '380001' })])
  })
})
