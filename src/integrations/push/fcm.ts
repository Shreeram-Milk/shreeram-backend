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

/** Sends through Firebase Cloud Messaging (free). Never logs a token or the message. */
export function createFcmSender(settings: FcmSettings): PushSender {
  let app: App | undefined
  const messaging = () => {
    app ??= getApps().find(existing => existing.name === APP_NAME) ?? initializeApp({ credential: cert(loadServiceAccount(settings) as Parameters<typeof cert>[0]) }, APP_NAME)
    return getMessaging(app)
  }
  return {
    channel: 'fcm',
    async send(tokens: string[], message: PushMessage): Promise<PushResult> {
      const result: PushResult = { sent: 0, invalidTokens: [] }
      for (let start = 0; start < tokens.length; start += BATCH_SIZE) {
        const batch = tokens.slice(start, start + BATCH_SIZE)
        const response = await messaging().sendEachForMulticast({
          tokens: batch,
          notification: { title: message.title, body: message.body },
          data: message.link ? { link: message.link } : {},
          // Offers are not urgent: normal priority, so they never wake a sleeping phone the way a delivery message may.
          android: { priority: message.channel === 'deliveries' ? 'high' : 'normal', notification: { channelId: message.channel } },
        })
        response.responses.forEach((outcome, index) => {
          if (outcome.success) result.sent += 1
          else if (outcome.error && DEAD_TOKEN_CODES.has(outcome.error.code)) result.invalidTokens.push(batch[index] as string)
        })
      }
      return result
    },
  }
}
