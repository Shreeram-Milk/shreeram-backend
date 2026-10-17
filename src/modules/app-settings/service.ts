import { PUBLIC_CACHE_SECONDS } from '../../http/public-cache.js'
import { createTtlCache } from '../../http/ttl-cache.js'
import type { AuditWriter } from '../audit/audit.js'
import type { AppSettingsRepository, StoredAppSettings } from './repository.js'
import type { AppSettingsInput } from './schema.js'

/** What the customer app reads: the settings without the save time. Nothing here is private (support numbers are shown to customers anyway). */
export type PublicAppSettings = Omit<StoredAppSettings, 'updatedAt'>

type Dependencies = { repository: AppSettingsRepository; audit: AuditWriter }
type Actor = { adminId: string; ip: string | null }

export function createAppSettingsService({ repository, audit }: Dependencies) {
  // Every phone reads the settings at start-up; the database answers once per interval.
  const publicSettings = createTtlCache<PublicAppSettings>(PUBLIC_CACHE_SECONDS * 1000)
  return {
    get: () => repository.get(),

    async save(input: AppSettingsInput, actor: Actor): Promise<StoredAppSettings> {
      const settings = await repository.save(input, actor.adminId)
      publicSettings.clear()
      // The audit entry names what was switched, never the support numbers or messages.
      await audit({ adminId: actor.adminId, action: 'app_settings_updated', details: { maintenanceMode: settings.maintenanceMode, minimumAppVersion: settings.minimumAppVersion }, ip: actor.ip })
      return settings
    },

    getPublic(): Promise<PublicAppSettings> {
      return publicSettings.get('settings', async () => {
        const { updatedAt, ...settings } = await repository.get()
        void updatedAt // a save time for the admin, not something the app shows
        return settings
      })
    },
  }
}

export type AppSettingsService = ReturnType<typeof createAppSettingsService>
