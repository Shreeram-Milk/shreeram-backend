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
