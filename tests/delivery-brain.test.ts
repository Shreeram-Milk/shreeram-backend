import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createDeliveryBrainService } from '../src/modules/delivery-brain/service.js'
import type { BrainSetup, BrainSlot, DeliveryBrainRepository } from '../src/modules/delivery-brain/repository.js'
import { createPublicDeliveryRouter } from '../src/modules/delivery-brain/routes.js'
import { addDays, cancelMoment, earliestDelivery, indiaClock, instantAt, orderByMoment } from '../src/modules/delivery-brain/rules.js'
import { errorHandler } from '../src/http/errors.js'

/** An India wall-clock time as a real moment: ist('2026-10-12', '10:00'). */
const ist = (date: string, time: string) => instantAt(date, time)
const MORNING = { startTime: '06:00', endTime: '09:00' }
const EVENING = { startTime: '17:00', endTime: '20:00' }

describe('India time', () => {
  it('reads the India date, not the server date, around midnight', () => {
    // 20:00 UTC on the 12th is already 01:30 on the 13th in India.
    expect(indiaClock(new Date('2026-10-12T20:00:00.000Z'))).toEqual({ date: '2026-10-13', minutes: 90 })
    expect(indiaClock(new Date('2026-10-11T18:30:00.000Z'))).toEqual({ date: '2026-10-12', minutes: 0 })
    expect(indiaClock(new Date('2026-10-12T18:29:00.000Z'))).toEqual({ date: '2026-10-12', minutes: 1439 })
  })
  it('adds days across month ends and leap days', () => {
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('until when a delivery can be cancelled or skipped', () => {
  it('uses the cancel time when the rule has one, otherwise the order cut-off', () => {
    const rule = { dayRelation: 'previous_day', cutoffTime: '15:00' } as const
    expect(orderByMoment('2026-10-17', rule)).toEqual(ist('2026-10-16', '15:00'))
    expect(cancelMoment('2026-10-17', rule)).toEqual(ist('2026-10-16', '15:00'))
    expect(cancelMoment('2026-10-17', { ...rule, cancelDayRelation: 'previous_day', cancelTime: '12:00' })).toEqual(ist('2026-10-16', '12:00'))
  })
  it('closes at midnight at the start of the delivery day when the slot has no cut-off rule', () => {
    expect(orderByMoment('2026-10-17', null)).toBeNull()
    expect(cancelMoment('2026-10-17', null)).toEqual(ist('2026-10-17', '00:00'))
  })
})

describe('earliest delivery with a "previous day" cut-off', () => {
  const rule = { dayRelation: 'previous_day', cutoffTime: '15:00' } as const
  it('is tomorrow before the cut-off, with the order-by moment shown', () => {
    const result = earliestDelivery(MORNING, rule, ist('2026-10-12', '10:00'))
    expect(result).toEqual({ date: '2026-10-13', orderBy: ist('2026-10-12', '15:00').toISOString() })
  })
  it('is the day after tomorrow once the cut-off has passed, and an order at the exact cut-off minute is late', () => {
    expect(earliestDelivery(MORNING, rule, ist('2026-10-12', '14:59')).date).toBe('2026-10-13')
    expect(earliestDelivery(MORNING, rule, ist('2026-10-12', '15:00')).date).toBe('2026-10-14')
    expect(earliestDelivery(MORNING, rule, ist('2026-10-12', '23:59')).date).toBe('2026-10-14')
  })
  it('starts a new day at India midnight, not UTC midnight', () => {
    expect(earliestDelivery(MORNING, rule, ist('2026-10-13', '00:00')).date).toBe('2026-10-14')
    expect(earliestDelivery(MORNING, rule, new Date('2026-10-12T20:00:00.000Z')).date).toBe('2026-10-14')
  })
  it('crosses a month end', () => {
    expect(earliestDelivery(MORNING, rule, ist('2026-10-31', '16:00')).date).toBe('2026-11-02')
  })
})

describe('earliest delivery with a "same day" cut-off', () => {
  const rule = { dayRelation: 'same_day', cutoffTime: '11:00' } as const
  it('is today before the cut-off and tomorrow from the cut-off minute on', () => {
    expect(earliestDelivery(EVENING, rule, ist('2026-10-12', '10:59'))).toEqual({ date: '2026-10-12', orderBy: ist('2026-10-12', '11:00').toISOString() })
    expect(earliestDelivery(EVENING, rule, ist('2026-10-12', '11:00')).date).toBe('2026-10-13')
  })
  it('never offers a slot that has already ended today, even if the cut-off has not passed', () => {
    const late = { dayRelation: 'same_day', cutoffTime: '21:00' } as const
    expect(earliestDelivery(EVENING, late, ist('2026-10-12', '19:59')).date).toBe('2026-10-12')
    expect(earliestDelivery(EVENING, late, ist('2026-10-12', '20:30'))).toEqual({ date: '2026-10-13', orderBy: ist('2026-10-13', '21:00').toISOString() })
  })
})

describe('earliest delivery with no cut-off rule', () => {
  it('is today while the slot has not started, otherwise tomorrow, with no order-by time', () => {
    expect(earliestDelivery(MORNING, null, ist('2026-10-12', '05:59'))).toEqual({ date: '2026-10-12', orderBy: null })
    expect(earliestDelivery(MORNING, null, ist('2026-10-12', '06:00')).date).toBe('2026-10-13')
    expect(earliestDelivery(EVENING, null, ist('2026-10-12', '10:00')).date).toBe('2026-10-12')
  })
})

const MORNING_SLOT: BrainSlot = { slotId: 'slot-morning', name: 'Morning', ...MORNING }
const EVENING_SLOT: BrainSlot = { slotId: 'slot-evening', name: 'Evening', ...EVENING }
const PRODUCT_ID = '6f1c2d3e-0000-4000-8000-000000000001'

function fakeBrain(profile: Partial<Omit<BrainSetup, 'area'>> & { area?: Partial<BrainSetup['area']>; productLive?: boolean } = {}, options: { pins?: Record<string, { locality: string; slots: BrainSlot[] }>; directory?: Record<string, string[]> } = {}) {
  const { productLive = true, ...setup } = profile
  const full: BrainSetup = {
    id: 'local_delivery:area-1:none', name: 'Gandhinagar milk', deliveryMethod: 'local_delivery', conditions: [
      { deliverySlotId: 'slot-morning', dayRelation: 'previous_day', cutoffTime: '15:00' },
      { deliverySlotId: 'slot-evening', dayRelation: 'same_day', cutoffTime: '11:00' },
    ],
    ...setup,
    area: { id: 'area-1', coverageType: 'pin_code', status: 'active', state: 'Gujarat', ...setup.area },
  }
  const repository: DeliveryBrainRepository = {
    async findProductSetup(id) { return id === PRODUCT_ID && productLive ? full : null },
    async listActiveSetups() { return productLive ? [full] : [] },
    async findServedPin(_areaId, pin) { return options.pins?.[pin] ?? null },
    async directoryStates(pin) { return options.directory?.[pin] ?? [] },
  }
  return createDeliveryBrainService({ repository, now: () => ist('2026-10-12', '10:00') })
}
const GANDHINAGAR = { '382010': { locality: 'Sector 10', slots: [MORNING_SLOT, EVENING_SLOT] }, '382011': { locality: 'Sector 11', slots: [MORNING_SLOT] } }

describe('delivery check', () => {
  it('serves a listed PIN with only its own slots, each with its own earliest date', async () => {
    const brain = fakeBrain({}, { pins: GANDHINAGAR })
    const both = await brain.check('382010', PRODUCT_ID)
    expect(both).toMatchObject({ served: true, deliveryMethod: 'local_delivery', locality: 'Sector 10' })
    expect(both.served && both.slots.map(slot => [slot.name, slot.earliestDate])).toEqual([['Morning', '2026-10-13'], ['Evening', '2026-10-12']])
    const morningOnly = await brain.check('382011', PRODUCT_ID)
    expect(morningOnly.served && morningOnly.slots.map(slot => slot.name)).toEqual(['Morning'])
  })
  it('does not serve a local PIN that is not in the list, and says nothing else about it', async () => {
    const brain = fakeBrain({}, { pins: GANDHINAGAR })
    expect(await brain.check('400001', PRODUCT_ID)).toEqual({ served: false, reason: 'NOT_SERVED' })
  })
  it('serves every valid PIN for an all-India shipping product, with no slots', async () => {
    const brain = fakeBrain({ deliveryMethod: 'shipping', conditions: [], area: { coverageType: 'pan_india', state: '' } })
    expect(await brain.check('400001', PRODUCT_ID)).toEqual({ served: true, deliveryMethod: 'shipping', locality: '', slots: [] })
  })
  it('serves a whole-state shipping product only for PINs the directory places in that state', async () => {
    const brain = fakeBrain({ deliveryMethod: 'shipping', conditions: [], area: { coverageType: 'state', state: 'gujarat ' } }, { directory: { '382010': ['GUJARAT'], '400001': ['MAHARASHTRA'] } })
    expect((await brain.check('382010', PRODUCT_ID)).served).toBe(true)
    expect(await brain.check('400001', PRODUCT_ID)).toEqual({ served: false, reason: 'NOT_SERVED' })
    expect(await brain.check('999999', PRODUCT_ID)).toEqual({ served: false, reason: 'NOT_SERVED' })
  })
  it('refuses a malformed PIN before touching anything', async () => {
    const brain = fakeBrain({}, { pins: GANDHINAGAR })
    for (const pin of ['', '38201', '3820101', '012345', 'abcdef', '38 2010']) expect(await brain.check(pin, PRODUCT_ID)).toEqual({ served: false, reason: 'INVALID_PIN' })
  })
  it('treats a missing, not-live or switched-off-area product as unavailable', async () => {
    expect(await fakeBrain({}, { pins: GANDHINAGAR }).check('382010', '6f1c2d3e-0000-4000-8000-000000000099')).toEqual({ served: false, reason: 'PRODUCT_UNAVAILABLE' })
    expect((await fakeBrain({ productLive: false }, { pins: GANDHINAGAR }).check('382010', PRODUCT_ID))).toEqual({ served: false, reason: 'PRODUCT_UNAVAILABLE' })
    expect((await fakeBrain({ area: { status: 'inactive' } }, { pins: GANDHINAGAR }).check('382010', PRODUCT_ID))).toEqual({ served: false, reason: 'PRODUCT_UNAVAILABLE' })
  })
  it('gives a slot with no condition in the rule the no-rule treatment', async () => {
    const brain = fakeBrain({ conditions: [{ deliverySlotId: 'slot-morning', dayRelation: 'previous_day', cutoffTime: '15:00' }] }, { pins: GANDHINAGAR })
    const result = await brain.check('382010', PRODUCT_ID)
    expect(result.served && result.slots.find(slot => slot.name === 'Evening')).toMatchObject({ earliestDate: '2026-10-12', orderBy: null })
  })
})

describe('which ways of delivering serve a PIN', () => {
  it('lists every way of delivering that serves the PIN, with its slots', async () => {
    const brain = fakeBrain({}, { pins: GANDHINAGAR })
    const options = await brain.servedOptions('382011')
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ optionId: 'local_delivery:area-1:none', name: 'Gandhinagar milk', deliveryMethod: 'local_delivery', locality: 'Sector 11' })
    expect(options[0]?.slots.map(slot => slot.name)).toEqual(['Morning'])
  })
  it('lists nothing for a PIN nobody serves, a malformed PIN, or when no product is live', async () => {
    expect(await fakeBrain({}, { pins: GANDHINAGAR }).servedOptions('400001')).toEqual([])
    expect(await fakeBrain({}, { pins: GANDHINAGAR }).servedOptions('38201')).toEqual([])
    expect(await fakeBrain({ productLive: false }, { pins: GANDHINAGAR }).servedOptions('382010')).toEqual([])
  })
})

describe('GET /public/delivery/check', () => {
  const app = (brain = fakeBrain({}, { pins: GANDHINAGAR })) => {
    const server = express()
    server.use('/public/delivery', createPublicDeliveryRouter({ delivery: brain }))
    server.use(errorHandler)
    return server
  }
  it('answers without signing in, and tells caches not to keep the answer', async () => {
    const response = await request(app()).get(`/public/delivery/check?pin=382011&productId=${PRODUCT_ID}`)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toMatchObject({ served: true, locality: 'Sector 11' })
  })
  it('answers "which ways of delivering serve this PIN" without signing in, uncached', async () => {
    const response = await request(app()).get('/public/delivery/check-pin?pin=382010')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.pin).toBe('382010')
    expect(response.body.options[0]).toMatchObject({ name: 'Gandhinagar milk', locality: 'Sector 10' })
    expect((await request(app()).get('/public/delivery/check-pin?pin=400001')).body.options).toEqual([])
    expect((await request(app()).get('/public/delivery/check-pin')).status).toBe(400)
  })
  it('refuses a missing PIN or a product id that is not an id', async () => {
    expect((await request(app()).get(`/public/delivery/check?productId=${PRODUCT_ID}`)).status).toBe(400)
    expect((await request(app()).get('/public/delivery/check?pin=382010&productId=nope')).status).toBe(400)
  })
})
