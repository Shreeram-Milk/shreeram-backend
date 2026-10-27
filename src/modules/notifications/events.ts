/** The automatic messages the system can send. The events are fixed by the system; staff edit only the wording. */
export const EVENT_KEYS = ['order_placed', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent'] as const
export type NotificationEventKey = (typeof EVENT_KEYS)[number]

/** What each message is allowed to mention: `{{order}}` in the wording is replaced by the real value. */
export const PLACEHOLDERS = ['order', 'product', 'date', 'window', 'amount'] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

export type EventDefinition = { key: NotificationEventKey; label: string; trigger: string; placeholders: Placeholder[] }

export const EVENT_DEFINITIONS: EventDefinition[] = [
  { key: 'order_placed', label: 'Order placed', trigger: 'When an order is placed: on credit, or paid online and confirmed.', placeholders: ['order', 'product'] },
  { key: 'out_for_delivery', label: 'Out for delivery', trigger: 'When staff mark an order out for delivery.', placeholders: ['order', 'product'] },
  { key: 'delivered', label: 'Delivered', trigger: 'When staff mark an order delivered.', placeholders: ['order', 'product'] },
  { key: 'day_skipped', label: 'Day skipped by staff', trigger: 'When staff skip a subscription or trial day, or cancel its order.', placeholders: ['product', 'date', 'window'] },
  { key: 'credit_limit_reached', label: 'Credit limit reached', trigger: 'When a subscription day is skipped because the credit limit is used up.', placeholders: ['product', 'date', 'window'] },
  { key: 'payment_requested', label: 'Payment requested', trigger: 'When staff ask a credit customer to pay.', placeholders: ['amount'] },
  { key: 'refund_sent', label: 'Refund sent', trigger: 'When staff record that a refund was sent.', placeholders: ['amount', 'order'] },
]

export const isEventKey = (value: string): value is NotificationEventKey => (EVENT_KEYS as readonly string[]).includes(value)
