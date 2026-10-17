/**
 * The payment provider as the rest of the backend sees it. PhonePe is the real one (phonepe.ts); development without PhonePe
 * settings uses the test gateway (test-gateway.ts), which is refused in production. Nothing outside this folder knows
 * PhonePe's URLs, field names or token format.
 */

/** Where a payment stands at the provider. PENDING may still turn into either of the others; COMPLETED and FAILED are final. */
export type GatewayState = 'PENDING' | 'COMPLETED' | 'FAILED'

/** What the phone needs to open the provider's checkout for one payment. */
export type GatewayCheckout = { providerOrderId: string; token: string; expiresAt: Date | null }

/** The provider's answer to "what happened to this payment?". The only source of truth for money: never the phone, never a webhook body. */
export type GatewayStatus = {
  state: GatewayState
  /** The amount the provider says this order is for, in paise; null if it did not say. */
  amountPaise: number | null
  providerOrderId: string | null
  /** The attempt that paid (or the latest attempt). */
  transactionId: string | null
  /** The provider's error code for a failed payment, or ''. */
  errorCode: string
  /** How the deciding attempt was paid, as far as the provider says. Never card numbers or UPI ids. */
  method: PaymentMethodDetails | null
}

/** How a payment was made, for staff: PhonePe's mode and instrument, the bank, and the bank's own reference (UTR / BRN). */
export type PaymentMethodDetails = { mode: string; instrument: string; bank: string; bankReference: string }

/** What the phone's PhonePe SDK is started with. 'TEST' means: no SDK, the test gateway confirms at once. */
export type SdkSettings = { environment: 'SANDBOX' | 'PRODUCTION' | 'TEST'; merchantId: string }

export interface PaymentGateway {
  readonly sdk: SdkSettings
  /** Creates the provider's order for one payment. `merchantOrderId` is ours, unique, letters/digits/_/- only, at most 63 characters. */
  createCheckout(input: { merchantOrderId: string; amountPaise: number; expireAfterSeconds: number }): Promise<GatewayCheckout>
  fetchStatus(merchantOrderId: string): Promise<GatewayStatus>
  /** Whether a webhook's Authorization header is genuine. Always false when webhooks are not configured. */
  verifyWebhook(authorization: string | undefined): boolean
}

/** The provider could not be reached or answered with something unusable. Never shown to customers in detail. */
export class PaymentGatewayError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'PaymentGatewayError'
  }
}
