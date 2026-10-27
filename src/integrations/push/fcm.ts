import { readFileSync } from 'node:fs'
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import type { PushMessage, PushResult, PushSender } from './push.js'

/** FCM accepts at most 500 phones in one request. */
const BATCH_SIZE = 500
const APP_NAME = 'shreeram-push'
/** Provider errors that mean "this notification address is gone for good". Anything else may be temporary and is not acted on. */
const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'])

export type FcmSettings = { serviceAccountFile?: string; serviceAccountJson?: string }

/** Reads the Firebase service account from a file (kept outside the code) or from a secret value. It is never logged. */
function loadServiceAccount({ serviceAccountFile, serviceAccountJson }: FcmSettings): Record<string, unknown> {
  const text = serviceAccountJson ?? (serviceAccountFile ? readFileSync(serviceAccountFile, 'utf8') : '')
  if (!text) throw new Error('Push needs FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_SERVICE_ACCOUNT_JSON.')
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || !('private_key' in parsed) || !('client_email' in parsed)) throw new Error('The Firebase service account file is not a service account key.')
  return parsed as Record<string, unknown>
}

/** Provider errors that are temporary (Firebase busy or rate-limiting): the same phone is tried once more a moment later. */
const TRANSIENT_CODES = new Set(['messaging/internal-error', 'messaging/server-unavailable', 'messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded'])

/** The one part of Firebase's messaging client the sender uses, so tests can stand in for it. */
export type MulticastClient = {
  sendEachForMulticast(message: { tokens: string[]; notification: { title: string; body: string }; data: Record<string, string>; android: { priority: 'high' | 'normal'; notification: { channelId: string } } }): Promise<{ responses: Array<{ success: boolean; error?: { code: string } }> }>
}
type SenderOptions = { client?: MulticastClient; retryDelayMs?: number }

/**
 * Sends through Firebase Cloud Messaging (free). Never logs a token or the message. One bad moment never costs the rest: a batch that
 * fails outright, and phones that failed for a temporary reason, are tried once more; a batch that still fails is skipped (and noted
 * in the log) so every later batch is still sent.
 */
export function createFcmSender(settings: FcmSettings, { client, retryDelayMs = 1500 }: SenderOptions = {}): PushSender {
  let app: App | undefined
  const messaging = (): MulticastClient => {
    if (client) return client
    app ??= getApps().find(existing => existing.name === APP_NAME) ?? initializeApp({ credential: cert(loadServiceAccount(settings) as Parameters<typeof cert>[0]) }, APP_NAME)
    return getMessaging(app) as unknown as MulticastClient
  }
  const pause = () => (retryDelayMs > 0 ? new Promise<void>(resolve => setTimeout(resolve, retryDelayMs)) : Promise.resolve())

  return {
    channel: 'fcm',
    async send(tokens: string[], message: PushMessage): Promise<PushResult> {
      const result: PushResult = { sent: 0, invalidTokens: [] }
      const payload = (batch: string[]) => ({
        tokens: batch,
        notification: { title: message.title, body: message.body },
        data: (message.link ? { link: message.link } : {}) as Record<string, string>,
        // Offers are not urgent: normal priority, so they never wake a sleeping phone the way a delivery message may.
        android: { priority: (message.channel === 'deliveries' ? 'high' : 'normal') as 'high' | 'normal', notification: { channelId: message.channel } },
      })
      /** Sends one batch and returns the phones that failed for a temporary reason (all of them when the whole request failed). */
      const attempt = async (batch: string[]): Promise<string[] | 'failed'> => {
        let response: Awaited<ReturnType<MulticastClient['sendEachForMulticast']>>
        try {
          response = await messaging().sendEachForMulticast(payload(batch))
        } catch {
          return 'failed'
        }
        const again: string[] = []
        response.responses.forEach((outcome, index) => {
          const token = batch[index] as string
          if (outcome.success) result.sent += 1
          else if (outcome.error && DEAD_TOKEN_CODES.has(outcome.error.code)) result.invalidTokens.push(token)
          else if (outcome.error && TRANSIENT_CODES.has(outcome.error.code)) again.push(token)
        })
        return again
      }

      for (let start = 0; start < tokens.length; start += BATCH_SIZE) {
        const batch = tokens.slice(start, start + BATCH_SIZE)
        let retry = await attempt(batch)
        if (retry === 'failed') retry = batch
        if (retry.length > 0) {
          await pause()
          const second = await attempt(retry)
          if (second === 'failed' || second.length > 0) console.warn(JSON.stringify({ level: 'warn', message: 'some phones could not be reached after a retry', phones: second === 'failed' ? retry.length : second.length }))
        }
      }
      return result
    },
  }
}
