import { createHash, timingSafeEqual } from 'node:crypto'
import { PaymentGatewayError, type GatewayCheckout, type GatewayState, type GatewayStatus, type PaymentGateway, type PaymentMethodDetails } from './gateway.js'

export type PhonePeSettings = {
  environment: 'sandbox' | 'production'
  clientId: string
  clientSecret: string
  clientVersion: number
  merchantId: string
  webhook?: { username: string; password: string }
}

type Fetch = typeof fetch

const HOSTS = {
  sandbox: { token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token', api: 'https://api-preprod.phonepe.com/apis/pg-sandbox' },
  production: { token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token', api: 'https://api.phonepe.com/apis/pg' },
} as const

/** A slow PhonePe must never hold a customer's request (or the webhook, which PhonePe wants answered in 3 to 5 seconds) for long. */
const TIMEOUT_MS = 8_000
/** A token is renewed this long before PhonePe says it expires, so a request never goes out with one that dies on the way. */
const TOKEN_MARGIN_MS = 5 * 60_000

type Json = Record<string, unknown>
const record = (value: unknown): Json | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null)
const STATES: readonly GatewayState[] = ['PENDING', 'COMPLETED', 'FAILED']

const short = (value: unknown, max: number): string => text(value).trim().slice(0, max)

/**
 * How one attempt was paid. PhonePe puts the rail (UPI or PG) and the instrument either on the attempt or on its first
 * "split instrument". Only safe facts are kept: the mode, the instrument type, the bank's name and the bank's reference.
 */
export function methodOf(attempt: Json | undefined): PaymentMethodDetails | null {
  if (!attempt) return null
  const mode = short(attempt.paymentMode, 40)
  if (!mode) return null
  const split = Array.isArray(attempt.splitInstruments) ? record(attempt.splitInstruments[0]) : null
  const rail = record(split?.rail) ?? record(attempt.rail)
  const instrument = record(split?.instrument) ?? record(attempt.instrument)
  return {
    mode,
    instrument: short(instrument?.type, 40),
    bank: short(instrument?.bankName, 100),
    // UPI: the UTR. Cards and net banking: the bank reference number, else the acquirer reference number.
    bankReference: short(rail?.utr, 100) || short(instrument?.brn, 100) || short(instrument?.arn, 100),
  }
}

/** PhonePe's order status (and webhook) body, read leniently: unknown fields are ignored, a missing state is treated as still pending. */
export function parseOrderStatus(body: unknown): GatewayStatus {
  const order = record(body) ?? {}
  const rawState = text(order.state).toUpperCase()
  const state: GatewayState = (STATES as readonly string[]).includes(rawState) ? (rawState as GatewayState) : 'PENDING'
  const attempts = Array.isArray(order.paymentDetails) ? order.paymentDetails.map(record).filter((item): item is Json => item !== null) : []
  // The attempt that decided the order: the completed one if any, otherwise the latest.
  const decisive = attempts.find(item => text(item.state).toUpperCase() === 'COMPLETED') ?? attempts[attempts.length - 1]
  const errorContext = record(order.errorContext)
  return {
    state,
    amountPaise: whole(order.amount),
    providerOrderId: text(order.orderId) || null,
    transactionId: decisive ? text(decisive.transactionId) || null : null,
    errorCode: text(order.errorCode) || text(errorContext?.errorCode) || (decisive ? text(decisive.errorCode) : ''),
    method: state === 'COMPLETED' ? methodOf(decisive) : null,
  }
}

/** SHA-256 of "username:password", as PhonePe puts it in a webhook's Authorization header (hex; base64 also accepted). */
export function webhookHashes(username: string, password: string): [hex: string, base64: string] {
  const digest = createHash('sha256').update(`${username}:${password}`, 'utf8').digest()
  return [digest.toString('hex'), digest.toString('base64')]
}

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The PhonePe Standard Checkout (v2) client. One access token is shared by every request and renewed shortly before it
 * expires; concurrent requests wait for the same renewal instead of each asking PhonePe for a token. Secrets never appear in
 * errors or logs.
 */
export function createPhonePeGateway(settings: PhonePeSettings, dependencies: { fetch?: Fetch; now?: () => number } = {}): PaymentGateway {
  const doFetch = dependencies.fetch ?? fetch
  const now = dependencies.now ?? Date.now
  const hosts = HOSTS[settings.environment]
  let token: { value: string; renewAt: number } | null = null
  let renewing: Promise<string> | null = null

  async function call(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let response: Response
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not be reached'
      throw new PaymentGatewayError(`PhonePe ${reason}.`)
    }
    const raw = await response.text()
    let body: unknown = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    return { status: response.status, body }
  }

  async function renewToken(): Promise<string> {
    const form = new URLSearchParams({ client_id: settings.clientId, client_version: String(settings.clientVersion), client_secret: settings.clientSecret, grant_type: 'client_credentials' })
    const { status, body } = await call(hosts.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() })
    const answer = record(body)
    const value = text(answer?.access_token)
    if (status !== 200 || !value) throw new PaymentGatewayError(`PhonePe refused the access token request (HTTP ${status}${text(answer?.code) ? `, ${text(answer?.code)}` : ''}).`, status)
    // expires_at is epoch seconds. If it is missing or odd, renew after 30 minutes rather than trusting it.
    const expiresAtMs = (whole(answer?.expires_at) ?? 0) * 1000
    const renewAt = expiresAtMs > now() + TOKEN_MARGIN_MS ? expiresAtMs - TOKEN_MARGIN_MS : now() + 30 * 60_000
    token = { value, renewAt }
    return value
  }

  async function accessToken(): Promise<string> {
    if (token && now() < token.renewAt) return token.value
    renewing ??= renewToken().finally(() => { renewing = null })
    return renewing
  }

  /** An API call with the shared token. If PhonePe says the token is no longer valid, it is renewed once and the call repeated. */
  async function authorised(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const send = async () => call(`${hosts.api}${path}`, { ...init, headers: { ...init.headers, 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `O-Bearer ${await accessToken()}` } })
    const first = await send()
    if (first.status !== 401) return first
    token = null
    return send()
  }

  const failure = (what: string, status: number, body: unknown) => {
    const code = text(record(body)?.code)
    return new PaymentGatewayError(`PhonePe ${what} failed (HTTP ${status}${code ? `, ${code}` : ''}).`, status)
  }

  const expected = settings.webhook ? webhookHashes(settings.webhook.username, settings.webhook.password) : null

  return {
    sdk: { environment: settings.environment === 'production' ? 'PRODUCTION' : 'SANDBOX', merchantId: settings.merchantId },

    async createCheckout({ merchantOrderId, amountPaise, expireAfterSeconds }): Promise<GatewayCheckout> {
      const { status, body } = await authorised('/checkout/v2/sdk/order', {
        method: 'POST',
        body: JSON.stringify({ merchantOrderId, amount: amountPaise, expireAfter: Math.min(3600, Math.max(300, Math.round(expireAfterSeconds))), paymentFlow: { type: 'PG_CHECKOUT' } }),
      })
      const answer = record(body)
      const providerOrderId = text(answer?.orderId)
      const orderToken = text(answer?.token)
      if (status !== 200 || !providerOrderId || !orderToken) throw failure('payment creation', status, body)
      const expiry = whole(answer?.expireAt) ?? whole(answer?.expiryAt)
      return { providerOrderId, token: orderToken, expiresAt: expiry ? new Date(expiry) : null }
    },

    async fetchStatus(merchantOrderId) {
      const { status, body } = await authorised(`/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false&errorContext=true`, { method: 'GET' })
      if (status !== 200) throw failure('status check', status, body)
      return parseOrderStatus(body)
    },

    verifyWebhook(authorization) {
      if (!authorization || !expected) return false
      const supplied = authorization.trim()
      const [hex, base64] = expected
      // Hex is compared without regard to letter case; base64 is case-sensitive by nature.
      return sameText(supplied.toLowerCase(), hex) || sameText(supplied, base64)
    },
  }
}
