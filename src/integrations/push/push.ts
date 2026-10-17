/**
 * The kind of message, as the phone's notification channel: `deliveries` for orders, payments and plan changes; `offers` for
 * messages staff send to a group. A customer can mute offers in the phone settings and still get delivery news. Must match the app.
 */
export type PushChannel = 'deliveries' | 'offers'

/** What is sent to a phone. `link` is a screen of the app to open when the customer taps it (the app checks it before opening). */
export type PushMessage = { title: string; body: string; link: string | null; channel: PushChannel }

export type PushResult = {
  /** How many phones the message was handed to. */
  sent: number
  /** Notification addresses the provider says no longer exist (app removed, phone reset). They are switched off. */
  invalidTokens: string[]
}

/** Sends one message to a list of phones. The real one talks to Firebase Cloud Messaging; tests and development use a stand-in. */
export interface PushSender {
  readonly channel: 'fcm' | 'console'
  send(tokens: string[], message: PushMessage): Promise<PushResult>
}

/** Development: nothing leaves the laptop; only a short line (the title and a count, never the message text or the tokens) shows that a push would go. */
export const consolePushSender: PushSender = {
  channel: 'console',
  async send(tokens, message) {
    console.log(`[DEV ONLY] Push to ${tokens.length} phone(s): "${message.title}" (set PUSH_MODE=fcm to really send)`)
    return { sent: tokens.length, invalidTokens: [] }
  },
}
