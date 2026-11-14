/** Money is whole paise (₹100 = 10000). */
export const WALLET_MIN_TOP_UP_PAISE = 10_000
/** The most a wallet may hold. Keeps it a small, closed "pay at ShreeRam" balance. */
export const WALLET_MAX_BALANCE_PAISE = 1_000_000

export const WALLET_ENTRY_TYPES = ['top_up', 'order_payment', 'order_return', 'refund_hold', 'refund_release', 'manual_adjustment'] as const
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number]
export type WalletDirection = 'credit' | 'debit'
export const REFUND_STATUSES = ['requested', 'sent', 'cancelled'] as const
export type RefundStatus = (typeof REFUND_STATUSES)[number]

/** A line's effect on the balance: a credit adds, a debit takes away. */
export const signedAmount = (entry: { direction: WalletDirection; amountPaise: number }): number => (entry.direction === 'credit' ? entry.amountPaise : -entry.amountPaise)
export const balanceOf = (entries: ReadonlyArray<{ direction: WalletDirection; amountPaise: number }>): number => entries.reduce((sum, entry) => sum + signedAmount(entry), 0)

/** How much more can be added before the wallet is full. */
export const topUpRoom = (balancePaise: number): number => Math.max(0, WALLET_MAX_BALANCE_PAISE - balancePaise)

/** Only an active prepaid customer can add money or pay with the wallet. Credit customers keep their monthly account. */
export const walletEnabled = (customer: { customerType: string; status: string }): boolean => customer.customerType !== 'credit' && customer.status === 'active'

/**
 * One customer's wallet in plain numbers. Always true: balance = added − spent + returned − refunded − waiting + adjusted.
 * `refunded` is what staff sent back through PhonePe; `waiting` is a request not yet sent (already taken out of the balance).
 */
export type WalletTotals = { addedPaise: number; spentPaise: number; returnedPaise: number; refundedPaise: number; waitingPaise: number; adjustedPaise: number; balancePaise: number }

export function walletTotals(
  entries: ReadonlyArray<{ type: WalletEntryType; direction: WalletDirection; amountPaise: number }>,
  requests: ReadonlyArray<{ status: RefundStatus; amountPaise: number }>,
): WalletTotals {
  const sumOf = (type: WalletEntryType) => entries.filter(entry => entry.type === type).reduce((sum, entry) => sum + entry.amountPaise, 0)
  const requested = (status: RefundStatus) => requests.filter(request => request.status === status).reduce((sum, request) => sum + request.amountPaise, 0)
  return {
    addedPaise: sumOf('top_up'), spentPaise: sumOf('order_payment'), returnedPaise: sumOf('order_return'),
    refundedPaise: requested('sent'), waitingPaise: requested('requested'),
    adjustedPaise: balanceOf(entries.filter(entry => entry.type === 'manual_adjustment')), balancePaise: balanceOf(entries),
  }
}

/** A PhonePe payment that added money, and how much of it has already gone back. */
export type RefundSource = { paymentId: string; amountPaise: number; refundedPaise: number }
export const leftToRefund = (source: RefundSource): number => Math.max(0, source.amountPaise - source.refundedPaise)

/**
 * Which PhonePe payments to refund a request from: the newest first, each up to what is left on it (PhonePe never refunds more
 * than a payment). Staff can change it; this is only the suggestion. Short when the payments cannot cover the amount.
 */
export function planRefund(amountPaise: number, sourcesNewestFirst: ReadonlyArray<RefundSource>): Array<{ paymentId: string; amountPaise: number }> {
  const plan: Array<{ paymentId: string; amountPaise: number }> = []
  let remaining = amountPaise
  for (const source of sourcesNewestFirst) {
    if (remaining <= 0) break
    const take = Math.min(remaining, leftToRefund(source))
    if (take > 0) { plan.push({ paymentId: source.paymentId, amountPaise: take }); remaining -= take }
  }
  return plan
}
