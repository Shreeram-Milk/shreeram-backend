import type { NotificationEventKey } from './events.js'

/** One automatic message about one thing that happened to one customer. */
export type NotifyInput = {
  event: NotificationEventKey
  customerId: string
  /** The real values for the placeholders in the wording, for example `{ order: 'SRM-1001' }`. */
  vars: Record<string, string>
  /** Values for the Gujarati wording only, such as the Gujarati product name and date. One left out or empty uses the value in `vars`. */
  varsGujarati?: Record<string, string>
  /** A screen of the app to open on tap, such as `/order-tracking?orderId=...`. */
  link?: string | null
  /** Names this exact occurrence (for example `order:<id>:delivered`), so repeating it never sends it twice. */
  dedupeKey: string
}

/**
 * What the rest of the system uses to tell a customer something. It never throws and never makes the caller wait for the phone:
 * an order, a skip or a refund must always succeed even when notifications are down.
 */
export interface Notifier {
  notify(input: NotifyInput): Promise<void>
}

export const noopNotifier: Notifier = { async notify() {} }
