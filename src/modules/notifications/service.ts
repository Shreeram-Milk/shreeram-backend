import type { PushChannel, PushSender } from '../../integrations/push/push.js'
import { AppError } from '../../http/errors.js'
import type { AuditWriter } from '../audit/audit.js'
import { EVENT_DEFINITIONS, type EventDefinition, type NotificationEventKey } from './events.js'
import type { Notifier, NotifyInput } from './notifier.js'
import type { Broadcast, NotificationRepository, Recipient, Template } from './repository.js'
import { pickLanguage, renderTemplate, safeLink, type Wording } from './rules.js'
import type { Audience, BroadcastInput, BroadcastListQuery, NotificationListQuery, RegisterTokenInput, TemplateUpdateInput } from './schema.js'

type Logger = { warn(data: object, message: string): void; error(data: object, message: string): void }
type Dependencies = { repository: NotificationRepository; sender: PushSender; audit: AuditWriter; logger?: Logger }
type Actor = { adminId: string; ip: string | null }

const quietLogger: Logger = {
  warn: (data, message) => console.warn(JSON.stringify({ level: 'warn', message, ...data })),
  error: (data, message) => console.error(JSON.stringify({ level: 'error', message, ...data, err: 'err' in data && data.err instanceof Error ? data.err.message : undefined })),
}

export type TemplateView = EventDefinition & Wording & { enabled: boolean; updatedAt: string }

const definitionOf = (event: NotificationEventKey): EventDefinition => EVENT_DEFINITIONS.find(item => item.key === event) as EventDefinition
const viewOf = (template: Template): TemplateView => ({ ...definitionOf(template.event), title: template.title, titleGujarati: template.titleGujarati, body: template.body, bodyGujarati: template.bodyGujarati, enabled: template.enabled, updatedAt: template.updatedAt })

/** Every `{{name}}` used in a piece of wording. */
const placeholdersIn = (text: string): string[] => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1] as string)

export function createNotificationService({ repository, sender, audit, logger = quietLogger }: Dependencies) {
  /** Pushes still going out. A request never waits for them; tests and a clean shutdown can (`flush`). */
  const pending = new Set<Promise<unknown>>()
  const inBackground = (task: Promise<unknown>) => {
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  /** Hands the message to every active phone of the recipients, in each customer's own language. Returns how many phones it reached. */
  async function deliver(recipients: Recipient[], wording: Wording, link: string | null, channel: PushChannel): Promise<number> {
    const tokensByCustomer = await repository.tokensFor(recipients.map(recipient => recipient.customerId))
    let pushed = 0
    for (const language of ['en', 'gu'] as const) {
      const tokens = [...new Set(recipients.filter(recipient => recipient.language === language).flatMap(recipient => tokensByCustomer.get(recipient.customerId) ?? []))]
      if (tokens.length === 0) continue
      const { title, body } = pickLanguage(wording, language)
      const result = await sender.send(tokens, { title, body, link: safeLink(link), channel })
      pushed += result.sent
      await repository.deactivateTokens(result.invalidTokens)
    }
    return pushed
  }

  const notifier: Notifier = {
    async notify({ event, customerId, vars, varsGujarati = {}, link = null, dedupeKey }: NotifyInput) {
      try {
        const template = await repository.getTemplate(event)
        if (!template || !template.enabled) return
        const customer = await repository.customerBrief(customerId)
        if (!customer || !customer.active) return
        // Gujarati wording gets Gujarati values (product name, date) where there are any; English values fill the rest.
        const gujaratiVars = { ...vars, ...Object.fromEntries(Object.entries(varsGujarati).filter(([, value]) => value.trim() !== '')) }
        const wording: Wording = {
          title: renderTemplate(template.title, vars), titleGujarati: renderTemplate(template.titleGujarati, gujaratiVars),
          body: renderTemplate(template.body, vars), bodyGujarati: renderTemplate(template.bodyGujarati, gujaratiVars),
        }
        const stored = await repository.addNotification({ ...wording, customerId, event, link: safeLink(link), dedupeKey })
        if (!stored) return
        inBackground(deliver([{ customerId, language: customer.language }], wording, stored.link, 'deliveries').catch(error => logger.warn({ err: error, event }, 'push could not be sent')))
      } catch (error) {
        logger.error({ err: error, event }, 'notification could not be stored')
      }
    },
  }

  return {
    notifier,
    /** Waits until every push already started has finished. */
    async flush(): Promise<void> { await Promise.allSettled([...pending]) },

    // ---- the customer's phone ----
    async registerToken(customerId: string, input: RegisterTokenInput): Promise<void> {
      await repository.upsertToken(customerId, input)
      if (input.language) await repository.setLanguage(customerId, input.language)
    },
    unregisterToken: (customerId: string, token: string) => repository.removeToken(customerId, token),
    listMine: (customerId: string, query: NotificationListQuery) => repository.listFor(customerId, query),
    unreadCount: (customerId: string) => repository.unreadCount(customerId),
    async markRead(customerId: string, id: string): Promise<void> {
      if (!(await repository.markRead(customerId, id))) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'That notification does not exist.')
    },
    markAllRead: (customerId: string) => repository.markAllRead(customerId),

    // ---- staff: the wording of the automatic messages ----
    async listTemplates(): Promise<TemplateView[]> {
      return (await repository.listTemplates()).map(viewOf)
    },
    async updateTemplate(event: NotificationEventKey, input: TemplateUpdateInput, actor: Actor): Promise<TemplateView> {
      const allowed: string[] = definitionOf(event).placeholders
      const unknown = [...new Set([input.title, input.titleGujarati, input.body, input.bodyGujarati].flatMap(placeholdersIn))].filter(name => !allowed.includes(name))
      if (unknown.length > 0) {
        throw new AppError(400, 'UNKNOWN_PLACEHOLDER', `This message cannot use ${unknown.map(name => `{{${name}}}`).join(', ')}. You can use: ${allowed.map(name => `{{${name}}}`).join(', ')}.`, { unknown, allowed })
      }
      const updated = await repository.updateTemplate(event, input, actor.adminId)
      if (!updated) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'That message does not exist.')
      await audit({ adminId: actor.adminId, action: 'notification_template_updated', details: { event, enabled: input.enabled }, ip: actor.ip })
      return viewOf(updated)
    },

    // ---- staff: messages to a group ----
    async previewAudience(audience: Audience): Promise<{ customers: number; withDevices: number }> { return repository.countAudience(audience) },
    async createBroadcast(input: BroadcastInput, actor: Actor): Promise<Broadcast> {
      const recipients = await repository.resolveAudience(input.audience)
      if (recipients.length === 0) throw new AppError(409, 'NO_RECIPIENTS', 'No active customers match this group.')
      const wording: Wording = { title: input.title, titleGujarati: input.titleGujarati, body: input.body, bodyGujarati: input.bodyGujarati }
      const link = input.opensOffers ? '/offers' : '/notifications'
      const broadcast = await repository.createBroadcast({ ...wording, audience: input.audience }, actor.adminId)
      let stored: string[]
      try {
        stored = await repository.addBroadcastNotifications(broadcast.id, recipients.map(recipient => recipient.customerId), wording, link)
      } catch (error) {
        // Never leave a message showing "Sending" for ever: it is marked as not delivered, and staff see the error.
        await repository.finishBroadcast(broadcast.id, { recipients: 0, pushed: 0, status: 'failed' }).catch(() => undefined)
        throw error
      }
      const storedSet = new Set(stored)
      inBackground((async () => {
        try {
          const pushed = await deliver(recipients.filter(recipient => storedSet.has(recipient.customerId)), wording, link, 'offers')
          await repository.finishBroadcast(broadcast.id, { recipients: stored.length, pushed, status: 'sent' })
        } catch (error) {
          logger.error({ err: error, broadcastId: broadcast.id }, 'broadcast push failed')
          await repository.finishBroadcast(broadcast.id, { recipients: stored.length, pushed: 0, status: 'failed' }).catch(() => undefined)
        }
      })())
      await audit({ adminId: actor.adminId, action: 'broadcast_sent', details: { broadcastId: broadcast.id, recipients: stored.length, audience: input.audience.type }, ip: actor.ip })
      return { ...broadcast, recipients: stored.length }
    },
    listBroadcasts: (query: BroadcastListQuery) => repository.listBroadcasts(query),
  }
}

export type NotificationService = ReturnType<typeof createNotificationService>
