import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PaymentGatewayError } from '../src/integrations/payments/gateway.js'
import { createPhonePeGateway, parseOrderStatus } from '../src/integrations/payments/phonepe.js'

type Call = { url: string; method: string; headers: Record<string, string>; body: string }
const SETTINGS = { environment: 'sandbox' as const, clientId: 'CLIENT_ID_X', clientSecret: 'very-secret-value', clientVersion: 1, merchantId: 'MERCHANT1', webhook: { username: 'hookuser', password: 'hookpass' } }
const NOW = Date.parse('2026-10-14T10:00:00.000Z')
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const tokenAnswer = (value = 'tok-1', expiresInSeconds = 3600) => json(200, { access_token: value, token_type: 'O-Bearer', expires_at: Math.floor(NOW / 1000) + expiresInSeconds })

/** A scripted PhonePe: answers in order, and records every request it receives. */
function fakePhonePe(...answers: Array<Response | Error | ((call: Call) => Response)>) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), body: String(init.body ?? '') }
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`Unexpected request to ${url}`)
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(call) : answer
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('PhonePe access token', () => {
  it('asks once with the client credentials and reuses the token for later calls', async () => {
    const phonePe = fakePhonePe(tokenAnswer(), json(200, { orderId: 'OMO1', token: 'ot1', state: 'PENDING' }), json(200, { orderId: 'OMO1', state: 'PENDING', amount: 500 }))
    const gateway = createPhonePeGateway(SETTINGS, { fetch: phonePe.fetch, now: () => NOW })
    await gateway.createCheckout({ merchantOrderId: 'SRM1', amountPaise: 500, expireAfterSeconds: 900 })
    await gateway.fetchStatus('SRM1')
    expect(phonePe.calls.map(call => call.url)).toEqual([
      'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
      'https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/sdk/order',
      'https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order/SRM1/status?details=false&errorContext=true',
    ])
    expect(phonePe.calls[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(phonePe.calls[0]?.body)).toEqual(new URLSearchParams({ client_id: 'CLIENT_ID_X', client_version: '1', client_secret: 'very-secret-value', grant_type: 'client_credentials' }))
    expect(phonePe.calls[1]?.headers.Authorization).toBe('O-Bearer tok-1')
  })

  it('shares one token request between calls made at the same moment', async () => {
    const phonePe = fakePhonePe(tokenAnswer(), json(200, { state: 'PENDING' }), json(200, { state: 'PENDING' }), json(200, { state: 'PENDING' }))
    const gateway = createPhonePeGateway(SETTINGS, { fetch: phonePe.fetch, now: () => NOW })
    await Promise.all([gateway.fetchStatus('SRM1'), gateway.fetchStatus('SRM2'), gateway.fetchStatus('SRM3')])
    expect(phonePe.calls.filter(call => call.url.endsWith('/oauth/token'))).toHaveLength(1)
  })

  it('renews the token shortly before it expires, and once more if PhonePe says it is no longer valid', async () => {
    let now = NOW
    const phonePe = fakePhonePe(tokenAnswer('tok-1', 3600), json(200, { state: 'PENDING' }), tokenAnswer('tok-2', 7200), json(401, { code: 'UNAUTHORIZED' }), tokenAnswer('tok-3', 7200), json(200, { state: 'COMPLETED' }))
    const gateway = createPhonePeGateway(SETTINGS, { fetch: phonePe.fetch, now: () => now })
    await gateway.fetchStatus('SRM1')
    now += 56 * 60_000 // within 5 minutes of the token's end
    expect((await gateway.fetchStatus('SRM1')).state).toBe('COMPLETED')
    const authorisations = phonePe.calls.filter(call => call.url.includes('/status')).map(call => call.headers.Authorization)
    expect(authorisations).toEqual(['O-Bearer tok-1', 'O-Bearer tok-2', 'O-Bearer tok-3'])
  })

  it('reports a refused token request without ever repeating the secret', async () => {
    const phonePe = fakePhonePe(json(400, { code: 'INVALID_CLIENT', message: 'bad very-secret-value' }))
    const gateway = createPhonePeGateway(SETTINGS, { fetch: phonePe.fetch, now: () => NOW })
    const error = await gateway.fetchStatus('SRM1').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PaymentGatewayError)
    expect((error as Error).message).toContain('INVALID_CLIENT')
    expect((error as Error).message).not.toContain('very-secret-value')
  })

  it('uses the production addresses for production', async () => {
    const phonePe = fakePhonePe(tokenAnswer(), json(200, { state: 'PENDING' }))
    await createPhonePeGateway({ ...SETTINGS, environment: 'production' }, { fetch: phonePe.fetch, now: () => NOW }).fetchStatus('SRM1')
    expect(phonePe.calls.map(call => call.url)).toEqual(['https://api.phonepe.com/apis/identity-manager/v1/oauth/token', 'https://api.phonepe.com/apis/pg/checkout/v2/order/SRM1/status?details=false&errorContext=true'])
  })
})

describe('creating a payment', () => {
  it('sends our reference, the amount in paise, a 5 to 60 minute window and the standard checkout flow', async () => {
    const phonePe = fakePhonePe(tokenAnswer(), json(200, { orderId: 'OMO123', token: 'order-token', state: 'PENDING', expireAt: NOW + 900_000 }))
    const gateway = createPhonePeGateway(SETTINGS, { fetch: phonePe.fetch, now: () => NOW })
    const checkout = await gateway.createCheckout({ merchantOrderId: 'SRMabc', amountPaise: 22000, expireAfterSeconds: 60 })
    expect(JSON.parse(phonePe.calls[1]?.body ?? '{}')).toEqual({ merchantOrderId: 'SRMabc', amount: 22000, expireAfter: 300, paymentFlow: { type: 'PG_CHECKOUT' } })
    expect(checkout).toEqual({ providerOrderId: 'OMO123', token: 'order-token', expiresAt: new Date(NOW + 900_000) })
    expect(gateway.sdk).toEqual({ environment: 'SANDBOX', merchantId: 'MERCHANT1' })
  })

  it('treats an answer without an order id or token as a failure, and a timeout as unreachable', async () => {
    const missing = fakePhonePe(tokenAnswer(), json(200, { orderId: 'OMO1' }))
    await expect(createPhonePeGateway(SETTINGS, { fetch: missing.fetch, now: () => NOW }).createCheckout({ merchantOrderId: 'SRM1', amountPaise: 100, expireAfterSeconds: 900 })).rejects.toThrow(PaymentGatewayError)
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const slow = fakePhonePe(tokenAnswer(), timeout)
    await expect(createPhonePeGateway(SETTINGS, { fetch: slow.fetch, now: () => NOW }).createCheckout({ merchantOrderId: 'SRM1', amountPaise: 100, expireAfterSeconds: 900 })).rejects.toThrow('PhonePe timed out.')
  })
})

describe('reading PhonePe\'s order status', () => {
  it('reads a completed payment, taking the transaction id of the attempt that paid', () => {
    expect(parseOrderStatus({ orderId: 'OMO1', state: 'COMPLETED', amount: 7000, paymentDetails: [{ transactionId: 'T-failed', state: 'FAILED' }, { transactionId: 'T-paid', state: 'COMPLETED', amount: 7000 }], newField: true }))
      .toEqual({ state: 'COMPLETED', amountPaise: 7000, providerOrderId: 'OMO1', transactionId: 'T-paid', errorCode: '', method: null })
  })
  it('reads a failure with its error code, and treats anything unknown as still pending', () => {
    expect(parseOrderStatus({ state: 'FAILED', amount: 200, paymentDetails: [{ transactionId: 'T1', state: 'FAILED', errorCode: 'ZM' }], errorContext: { errorCode: 'AUTHORIZATION_ERROR' } }))
      .toMatchObject({ state: 'FAILED', errorCode: 'AUTHORIZATION_ERROR', transactionId: 'T1' })
    expect(parseOrderStatus({ state: 'SOMETHING_NEW' }).state).toBe('PENDING')
    expect(parseOrderStatus(null)).toEqual({ state: 'PENDING', amountPaise: null, providerOrderId: null, transactionId: null, errorCode: '', method: null })
    expect(parseOrderStatus({ state: 'COMPLETED', amount: '7000' }).amountPaise).toBeNull()
  })
})

describe('how a payment was made', () => {
  it('reads net banking from the split instrument: bank name and bank reference', () => {
    const status = parseOrderStatus({ state: 'COMPLETED', amount: 75000, paymentDetails: [{ paymentMode: 'NET_BANKING', transactionId: 'OM1', state: 'COMPLETED',
      splitInstruments: [{ rail: { type: 'PG' }, instrument: { type: 'NET_BANKING', bankId: 'ABCD', bankName: 'temp bank', arn: 'ARN1', brn: 'BRN1' } }] }] })
    expect(status.method).toEqual({ mode: 'NET_BANKING', instrument: 'NET_BANKING', bank: 'temp bank', bankReference: 'BRN1' })
  })
  it('reads UPI with its UTR from the rail on the attempt, and never keeps the UPI id', () => {
    const status = parseOrderStatus({ state: 'COMPLETED', paymentDetails: [{ paymentMode: 'UPI_INTENT', state: 'COMPLETED', rail: { type: 'UPI', utr: 'UTR123', vpa: 'someone@ybl' }, instrument: { type: 'ACCOUNT', maskedAccountNumber: 'XX12' } }] })
    expect(status.method).toEqual({ mode: 'UPI_INTENT', instrument: 'ACCOUNT', bank: '', bankReference: 'UTR123' })
    expect(JSON.stringify(status)).not.toContain('someone@ybl')
  })
  it('reports no method until the payment has completed', () => {
    expect(parseOrderStatus({ state: 'PENDING', paymentDetails: [{ paymentMode: 'UPI_INTENT', state: 'PENDING' }] }).method).toBeNull()
  })
})

describe('webhook authorisation', () => {
  const digest = createHash('sha256').update('hookuser:hookpass').digest()
  const gateway = createPhonePeGateway(SETTINGS, { fetch: fakePhonePe().fetch, now: () => NOW })
  it('accepts SHA256(username:password) in hex (any letter case) or base64, and nothing else', () => {
    expect(gateway.verifyWebhook(digest.toString('hex'))).toBe(true)
    expect(gateway.verifyWebhook(digest.toString('hex').toUpperCase())).toBe(true)
    expect(gateway.verifyWebhook(digest.toString('base64'))).toBe(true)
    expect(gateway.verifyWebhook(` ${digest.toString('hex')} `)).toBe(true)
    expect(gateway.verifyWebhook(undefined)).toBe(false)
    expect(gateway.verifyWebhook('')).toBe(false)
    expect(gateway.verifyWebhook(createHash('sha256').update('hookuser:wrong').digest('hex'))).toBe(false)
  })
  it('accepts no webhook at all when none is configured', () => {
    const plain = createPhonePeGateway({ ...SETTINGS, webhook: undefined }, { fetch: fakePhonePe().fetch, now: () => NOW })
    expect(plain.verifyWebhook(digest.toString('hex'))).toBe(false)
  })
})
