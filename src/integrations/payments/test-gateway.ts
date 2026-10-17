import { randomUUID } from 'node:crypto'
import type { PaymentGateway } from './gateway.js'

/**
 * Development only, when no PhonePe settings are present: every payment is created and immediately reported as paid, with
 * clearly marked test ids. No money moves and the phone skips PhonePe's screen. Never used in production (the environment
 * check refuses a production start without PhonePe settings).
 */
export function createTestGateway(): PaymentGateway {
  const amounts = new Map<string, number>()
  return {
    sdk: { environment: 'TEST', merchantId: 'TEST' },
    async createCheckout({ merchantOrderId, amountPaise }) {
      amounts.set(merchantOrderId, amountPaise)
      return { providerOrderId: `TEST-${randomUUID()}`, token: 'TEST', expiresAt: null }
    },
    async fetchStatus(merchantOrderId) {
      const amount = amounts.get(merchantOrderId)
      // After a backend restart the amount is forgotten; the payment then stays pending rather than being guessed as paid.
      if (amount === undefined) return { state: 'PENDING', amountPaise: null, providerOrderId: null, transactionId: null, errorCode: '', method: null }
      return { state: 'COMPLETED', amountPaise: amount, providerOrderId: null, transactionId: `TEST-${merchantOrderId}`, errorCode: '', method: { mode: 'TEST', instrument: '', bank: '', bankReference: '' } }
    },
    verifyWebhook: () => false,
  }
}
