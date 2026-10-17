import { PUBLIC_CACHE_SECONDS } from '../../http/public-cache.js'
import { createTtlCache } from '../../http/ttl-cache.js'
import type { AuditWriter } from '../audit/audit.js'
import type { StoredWebsiteHome, WebsiteHomeRepository } from './repository.js'
import type { WebsiteHomeInput } from './schema.js'

type Dependencies = { repository: WebsiteHomeRepository; audit: AuditWriter }
type Actor = { adminId: string; ip: string | null }

export function createWebsiteHomeService({ repository, audit }: Dependencies) {
  // The website rebuilds its Home page every few minutes; the database answers at most once per interval.
  const publicHome = createTtlCache<StoredWebsiteHome>(PUBLIC_CACHE_SECONDS * 1000)
  return {
    get: () => repository.get(),
    getPublic: () => publicHome.get('home', () => repository.get()),
    async save(input: WebsiteHomeInput, actor: Actor): Promise<StoredWebsiteHome> {
      const home = await repository.save(input, actor.adminId)
      publicHome.clear()
      await audit({ adminId: actor.adminId, action: 'website_home_updated', details: { showProducts: home.showProducts }, ip: actor.ip })
      return home
    },
  }
}

export type WebsiteHomeService = ReturnType<typeof createWebsiteHomeService>
