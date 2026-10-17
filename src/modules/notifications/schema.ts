import { z } from 'zod'
import { EVENT_KEYS } from './events.js'

export const TITLE_MAX = 60
export const BODY_MAX = 240
const MAX_PIN_CODES = 50
const MAX_CHOSEN_CUSTOMERS = 200

const page = z.coerce.number().int().min(1).max(10_000).default(1)
const pageSize = (fallback: number) => z.coerce.number().int().min(1).max(100).default(fallback)

export const registerTokenSchema = z.object({
  token: z.string().trim().min(20, 'That is not a notification address.').max(4096, 'That is not a notification address.'),
  platform: z.enum(['android', 'ios']),
  /** The language the customer chose in the app, so messages reach them in it. */
  language: z.enum(['en', 'gu']).optional(),
})
export type RegisterTokenInput = z.infer<typeof registerTokenSchema>

export const unregisterTokenSchema = z.object({ token: z.string().trim().min(20).max(4096) })

export const notificationListQuerySchema = z.object({ page, pageSize: pageSize(30) })
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>

export const notificationIdParamsSchema = z.object({ id: z.uuid('That is not a valid notification id.') })

export const eventParamsSchema = z.object({ event: z.enum(EVENT_KEYS) })

const title = z.string().trim().min(1, 'Enter a title.').max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`)
const body = z.string().trim().min(1, 'Enter the message.').max(BODY_MAX, `Keep the message under ${BODY_MAX} characters.`)
const titleGujarati = z.string().trim().max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`).default('')
const bodyGujarati = z.string().trim().max(BODY_MAX, `Keep the message under ${BODY_MAX} characters.`).default('')

export const templateUpdateSchema = z.object({ title, titleGujarati, body, bodyGujarati, enabled: z.boolean() })
export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>

/** Who a broadcast goes to: everyone, a group chosen by filters, or customers picked one by one. Blocked and deleted customers never receive one. */
export const audienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({
    type: z.literal('filter'),
    customerType: z.enum(['prepaid', 'credit']).optional(),
    pinCodes: z.array(z.string().regex(/^[1-9][0-9]{5}$/, 'Use 6-digit PIN codes.')).max(MAX_PIN_CODES, `Choose at most ${MAX_PIN_CODES} PIN codes.`).optional(),
    hasActiveSubscription: z.boolean().optional(),
  }),
  z.object({ type: z.literal('customers'), customerIds: z.array(z.uuid()).min(1, 'Choose at least one customer.').max(MAX_CHOSEN_CUSTOMERS, `Choose at most ${MAX_CHOSEN_CUSTOMERS} customers.`) }),
])
export type Audience = z.infer<typeof audienceSchema>

export const audiencePreviewSchema = z.object({ audience: audienceSchema })

/** `opensOffers`: tapping the message opens the Offers page instead of the message list. */
export const broadcastSchema = z.object({ title, titleGujarati, body, bodyGujarati, audience: audienceSchema, opensOffers: z.boolean().default(false) })
export type BroadcastInput = z.infer<typeof broadcastSchema>

export const broadcastListQuerySchema = z.object({ page, pageSize: pageSize(20) })
export type BroadcastListQuery = z.infer<typeof broadcastListQuerySchema>
