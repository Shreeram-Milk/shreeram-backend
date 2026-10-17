import { randomUUID } from 'node:crypto'
import type { PushMessage, PushSender } from '../src/integrations/push/push.js'
import type { Customer } from '../src/modules/customer-auth/repository.js'
import type { NotificationEventKey } from '../src/modules/notifications/events.js'
import type { Broadcast, NotificationRepository, StoredNotification, Template } from '../src/modules/notifications/repository.js'
import type { Audience } from '../src/modules/notifications/schema.js'

/** The wording the migration seeds, so tests see the same messages staff see on a fresh database. */
const DEFAULT_TEMPLATES: Array<[NotificationEventKey, string, string, string, string]> = [
  ['out_for_delivery', 'On its way', 'ડિલિવરી માટે નીકળી', 'Your order {{order}} is out for delivery.', 'તમારો ઓર્ડર {{order}} ડિલિવરી માટે નીકળી ગયો છે.'],
  ['delivered', 'Delivered', 'ડિલિવર થઈ ગયો', 'Your order {{order}} has been delivered. Enjoy!', 'તમારો ઓર્ડર {{order}} ડિલિવર થઈ ગયો છે.'],
  ['day_skipped', 'Delivery skipped', 'ડિલિવરી છોડાઈ', 'Your {{product}} delivery on {{date}} ({{window}}) was skipped by our team.', '{{date}} ની {{product}} ડિલિવરી છોડાઈ.'],
  ['credit_limit_reached', 'Credit limit reached', 'ક્રેડિટ મર્યાદા પૂરી', 'Your {{product}} delivery on {{date}} was skipped because your credit limit is used up.', 'ક્રેડિટ મર્યાદા પૂરી થઈ છે.'],
  ['payment_requested', 'Payment requested', 'ચુકવણીની વિનંતી', 'Please pay {{amount}} to clear your balance.', 'કૃપા કરીને {{amount}} ચૂકવો.'],
  ['refund_sent', 'Refund sent', 'રિફંડ મોકલાયું', 'Your refund of {{amount}} has been sent.', 'તમારું {{amount}} નું રિફંડ મોકલાયું છે.'],
]

export type SentPush = PushMessage & { tokens: string[] }

/** In-memory notifications. Audiences understand "all", "chosen customers" and the customer-type filter; the PIN and subscription filters are the database's job (tested as SQL). */
export function createFakeNotificationStore({ customers, now }: { customers: Map<string, Customer>; now: () => Date }) {
  const tokens: Array<{ customerId: string; token: string; platform: 'android' | 'ios'; active: boolean }> = []
  const templates = new Map<NotificationEventKey, Template>(
    DEFAULT_TEMPLATES.map(([event, title, titleGujarati, body, bodyGujarati]) => [event, { event, title, titleGujarati, body, bodyGujarati, enabled: true, updatedAt: now().toISOString() }]),
  )
  const notifications: Array<StoredNotification & { customerId: string; dedupeKey: string | null }> = []
  const broadcasts: Broadcast[] = []

  /** What the stand-in sender was asked to push; a test can mark tokens as dead to see them switched off. */
  const pushes: SentPush[] = []
  const deadTokens = new Set<string>()
  const sender: PushSender = {
    channel: 'console',
    async send(list, message) {
      pushes.push({ ...message, tokens: list })
      const invalidTokens = list.filter(token => deadTokens.has(token))
      return { sent: list.length - invalidTokens.length, invalidTokens }
    },
  }

  const matches = (customer: Customer, audience: Audience): boolean => {
    if (customer.status !== 'active') return false
    if (audience.type === 'customers') return audience.customerIds.includes(customer.id)
    if (audience.type === 'filter' && audience.customerType && customer.customerType !== audience.customerType) return false
    return true
  }
  const activeTokens = (customerId: string) => tokens.filter(item => item.customerId === customerId && item.active).map(item => item.token)

  const repository: NotificationRepository = {
    async upsertToken(customerId, { token, platform }) {
      const existing = tokens.find(item => item.token === token)
      if (existing) Object.assign(existing, { customerId, platform, active: true })
      else tokens.push({ customerId, token, platform, active: true })
    },
    async setLanguage(customerId, language) { const customer = customers.get(customerId); if (customer) customer.language = language },
    async removeToken(customerId, token) { for (const item of tokens) if (item.customerId === customerId && item.token === token) item.active = false },
    async deactivateTokens(list) { for (const item of tokens) if (list.includes(item.token)) item.active = false },
    async tokensFor(customerIds) {
      const result = new Map<string, string[]>()
      for (const id of customerIds) { const list = activeTokens(id); if (list.length > 0) result.set(id, list) }
      return result
    },
    async customerBrief(customerId) {
      const customer = customers.get(customerId)
      return customer ? { id: customer.id, language: customer.language, active: customer.status === 'active' } : null
    },

    async listTemplates() { return [...templates.values()] },
    async getTemplate(event) { return templates.get(event) ?? null },
    async updateTemplate(event, input) {
      const current = templates.get(event)
      if (!current) return null
      const updated: Template = { ...current, ...input, updatedAt: now().toISOString() }
      templates.set(event, updated)
      return updated
    },

    async addNotification(input) {
      if (notifications.some(item => item.customerId === input.customerId && item.dedupeKey === input.dedupeKey)) return null
      const stored = { id: randomUUID(), event: input.event, title: input.title, titleGujarati: input.titleGujarati, body: input.body, bodyGujarati: input.bodyGujarati, link: input.link, broadcastId: null, createdAt: now().toISOString(), readAt: null, customerId: input.customerId, dedupeKey: input.dedupeKey }
      notifications.push(stored)
      return stored
    },
    async addBroadcastNotifications(broadcastId, customerIds, wording) {
      const added: string[] = []
      for (const customerId of customerIds) {
        const key = `broadcast:${broadcastId}`
        if (notifications.some(item => item.customerId === customerId && item.dedupeKey === key)) continue
        notifications.push({ id: randomUUID(), event: 'broadcast', ...wording, link: null, broadcastId, createdAt: now().toISOString(), readAt: null, customerId, dedupeKey: key })
        added.push(customerId)
      }
      return added
    },
    async listFor(customerId, { page, pageSize }) {
      const mine = notifications.filter(item => item.customerId === customerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return { notifications: mine.slice((page - 1) * pageSize, page * pageSize), total: mine.length, unread: mine.filter(item => !item.readAt).length }
    },
    async unreadCount(customerId) { return notifications.filter(item => item.customerId === customerId && !item.readAt).length },
    async markRead(customerId, id) {
      const found = notifications.find(item => item.id === id && item.customerId === customerId)
      if (!found) return false
      found.readAt ??= now().toISOString()
      return true
    },
    async markAllRead(customerId) {
      const unread = notifications.filter(item => item.customerId === customerId && !item.readAt)
      for (const item of unread) item.readAt = now().toISOString()
      return unread.length
    },

    async resolveAudience(audience) { return [...customers.values()].filter(customer => matches(customer, audience)).map(customer => ({ customerId: customer.id, language: customer.language })) },
    async countAudience(audience) {
      const list = [...customers.values()].filter(customer => matches(customer, audience))
      return { customers: list.length, withDevices: list.filter(customer => activeTokens(customer.id).length > 0).length }
    },
    async createBroadcast(input) {
      const broadcast: Broadcast = { id: randomUUID(), ...input, recipients: 0, pushed: 0, status: 'sending', createdAt: now().toISOString(), finishedAt: null }
      broadcasts.push(broadcast)
      return broadcast
    },
    async finishBroadcast(id, result) { const found = broadcasts.find(item => item.id === id); if (found) Object.assign(found, result, { finishedAt: now().toISOString() }) },
    async listBroadcasts({ page, pageSize }) {
      const sorted = [...broadcasts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return { rows: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length }
    },
  }
  return { repository, sender, tokens, templates, notifications, broadcasts, pushes, deadTokens }
}
