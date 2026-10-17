import type { Database } from '../../db/pool.js'
import type { AppSettingsInput } from './schema.js'

export type StoredAppSettings = AppSettingsInput & { updatedAt: string }

/** Storage for the one settings record. The Postgres version below is the real one; tests use a fake. */
export interface AppSettingsRepository {
  get(): Promise<StoredAppSettings>
  save(input: AppSettingsInput, adminId: string): Promise<StoredAppSettings>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const COLUMNS = `support_phone, support_email, support_whatsapp, call_enabled, chat_enabled, whatsapp_enabled, support_hours_en, support_hours_gu,
  after_hours_message_en, after_hours_message_gu, delivery_promise_en, delivery_promise_gu, minimum_app_version, maintenance_mode,
  maintenance_message_en, maintenance_message_gu, show_maintenance_contact, flag_show_trials, flag_show_subscriptions, flag_show_offers,
  flag_show_quality_reports, flag_show_seasonal_banner, updated_at`

const toSettings = (row: Row): StoredAppSettings => ({
  supportPhone: String(row.support_phone), supportEmail: String(row.support_email), supportWhatsApp: String(row.support_whatsapp),
  callEnabled: Boolean(row.call_enabled), chatEnabled: Boolean(row.chat_enabled), whatsappEnabled: Boolean(row.whatsapp_enabled),
  supportHoursEn: String(row.support_hours_en), supportHoursGu: String(row.support_hours_gu),
  afterHoursMessageEn: String(row.after_hours_message_en), afterHoursMessageGu: String(row.after_hours_message_gu),
  deliveryPromiseEn: String(row.delivery_promise_en), deliveryPromiseGu: String(row.delivery_promise_gu),
  minimumAppVersion: String(row.minimum_app_version), maintenanceMode: Boolean(row.maintenance_mode),
  maintenanceMessageEn: String(row.maintenance_message_en), maintenanceMessageGu: String(row.maintenance_message_gu),
  showMaintenanceContact: Boolean(row.show_maintenance_contact),
  flags: { showTrials: Boolean(row.flag_show_trials), showSubscriptions: Boolean(row.flag_show_subscriptions), showOffers: Boolean(row.flag_show_offers), showQualityReports: Boolean(row.flag_show_quality_reports), showSeasonalBanner: Boolean(row.flag_show_seasonal_banner) },
  updatedAt: iso(row.updated_at),
})

export function createAppSettingsRepository(database: Database): AppSettingsRepository {
  return {
    async get() {
      const { rows } = await database.query<Row>(`select ${COLUMNS} from app_settings where id`)
      // The starting row is created by the migration. If it is missing, say so plainly instead of guessing.
      if (!rows[0]) throw new Error('The app_settings row is missing. Run migration 0005_app_settings.sql.')
      return toSettings(rows[0])
    },
    async save(input, adminId) {
      const { rows } = await database.query<Row>(
        `update app_settings set support_phone = $1, support_email = $2, support_whatsapp = $3, call_enabled = $4, chat_enabled = $5, whatsapp_enabled = $6,
           support_hours_en = $7, support_hours_gu = $8, after_hours_message_en = $9, after_hours_message_gu = $10, delivery_promise_en = $11, delivery_promise_gu = $12,
           minimum_app_version = $13, maintenance_mode = $14, maintenance_message_en = $15, maintenance_message_gu = $16, show_maintenance_contact = $17,
           flag_show_trials = $18, flag_show_subscriptions = $19, flag_show_offers = $20, flag_show_quality_reports = $21, flag_show_seasonal_banner = $22,
           updated_at = now(), updated_by = $23 where id returning ${COLUMNS}`,
        [input.supportPhone, input.supportEmail, input.supportWhatsApp, input.callEnabled, input.chatEnabled, input.whatsappEnabled, input.supportHoursEn, input.supportHoursGu,
          input.afterHoursMessageEn, input.afterHoursMessageGu, input.deliveryPromiseEn, input.deliveryPromiseGu, input.minimumAppVersion, input.maintenanceMode,
          input.maintenanceMessageEn, input.maintenanceMessageGu, input.showMaintenanceContact, input.flags.showTrials, input.flags.showSubscriptions, input.flags.showOffers,
          input.flags.showQualityReports, input.flags.showSeasonalBanner, adminId],
      )
      if (!rows[0]) throw new Error('The app_settings row is missing. Run migration 0005_app_settings.sql.')
      return toSettings(rows[0])
    },
  }
}
