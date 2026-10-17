import { AppError } from '../../http/errors.js'
import { PUBLIC_CACHE_SECONDS } from '../../http/public-cache.js'
import { createTtlCache } from '../../http/ttl-cache.js'
import { ValidationError } from '../../http/validate.js'
import type { AuditWriter } from '../audit/audit.js'
import type { Faq, HelpRepository, HelpTopic } from './repository.js'
import { MAX_FEATURED_FAQS, type FaqInput, type FaqListQuery, type FaqStatus } from './schema.js'

/** What the customer app reads: the topics and the published questions, in one answer. */
export type PublicHelp = {
  topics: HelpTopic[]
  faqs: Array<Pick<Faq, 'id' | 'topic' | 'questionEn' | 'questionGu' | 'answerEn' | 'answerGu' | 'searchKeywords' | 'featured' | 'sortOrder'>>
}

type Dependencies = { repository: HelpRepository; audit: AuditWriter }
type Actor = { adminId: string; ip: string | null }

const notFound = () => new AppError(404, 'FAQ_NOT_FOUND', 'That question does not exist.')

export function createHelpService({ repository, audit }: Dependencies) {
  // Every phone opens Help; the database answers once per interval.
  const publicHelp = createTtlCache<PublicHelp>(PUBLIC_CACHE_SECONDS * 1000)

  /** The rules that need other records. The shape of the input was already checked by the schema. */
  async function checkRules(input: FaqInput, id?: string) {
    if (input.featured && input.status !== 'published') throw new ValidationError([{ field: 'featured', message: 'Only a published question can be popular.' }])
    if (await repository.questionExists(input.topic, input.questionEn, id)) throw new AppError(409, 'FAQ_DUPLICATE', 'This question already exists under the same topic.')
    if (input.featured && (await repository.countFeatured(id)) >= MAX_FEATURED_FAQS) throw new AppError(409, 'FAQ_FEATURED_LIMIT', `Only ${MAX_FEATURED_FAQS} questions can be popular. Remove one first.`)
  }

  return {
    list: (query: FaqListQuery) => repository.list(query),

    async get(id: string): Promise<Faq> {
      const faq = await repository.findById(id)
      if (!faq) throw notFound()
      return faq
    },

    async create(input: FaqInput, actor: Actor): Promise<Faq> {
      await checkRules(input)
      const faq = await repository.create(input, actor.adminId)
      publicHelp.clear()
      await audit({ adminId: actor.adminId, action: 'faq_created', details: { faqId: faq.id }, ip: actor.ip })
      return faq
    },

    async update(id: string, input: FaqInput, actor: Actor): Promise<Faq> {
      if (!(await repository.findById(id))) throw notFound()
      await checkRules(input, id)
      const faq = await repository.update(id, input, actor.adminId)
      if (!faq) throw notFound()
      publicHelp.clear()
      await audit({ adminId: actor.adminId, action: 'faq_updated', details: { faqId: id }, ip: actor.ip })
      return faq
    },

    async setStatus(id: string, status: FaqStatus, actor: Actor): Promise<Faq> {
      const faq = await repository.setStatus(id, status, actor.adminId)
      if (!faq) throw notFound()
      publicHelp.clear()
      await audit({ adminId: actor.adminId, action: 'faq_status_changed', details: { faqId: id, status }, ip: actor.ip })
      return faq
    },

    getPublic(): Promise<PublicHelp> {
      return publicHelp.get('help', async () => {
        const [topics, faqs] = await Promise.all([repository.listTopics(), repository.listPublished()])
        return {
          topics,
          faqs: faqs.map(faq => ({ id: faq.id, topic: faq.topic, questionEn: faq.questionEn, questionGu: faq.questionGu, answerEn: faq.answerEn, answerGu: faq.answerGu, searchKeywords: faq.searchKeywords, featured: faq.featured, sortOrder: faq.sortOrder })),
        }
      })
    },
  }
}

export type HelpService = ReturnType<typeof createHelpService>
