import { z } from 'zod'

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default('')
/** An Indian mobile number, with or without +91. Spaces and dashes typed by staff are removed before it is stored. */
const mobile = z.string().trim().default('').transform(value => value.replace(/[\s-]/g, '')).refine(value => value === '' || /^(\+91)?[6-9]\d{9}$/.test(value), 'Enter a 10-digit Indian mobile number.')

export const featureFlagsSchema = z.object({
  showTrials: z.boolean(),
  showSubscriptions: z.boolean(),
  showOffers: z.boolean(),
  showQualityReports: z.boolean(),
  showSeasonalBanner: z.boolean(),
})

/** Everything staff can change on the App Settings page. One record for the whole business. */
export const appSettingsSchema = z.object({
  supportPhone: mobile,
  supportEmail: z.string().trim().max(120, 'Keep this under 120 characters.').default('').refine(value => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address.'),
  supportWhatsApp: mobile,
  callEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  whatsappEnabled: z.boolean(),
  supportHoursEn: text(80),
  supportHoursGu: text(80),
  afterHoursMessageEn: text(160),
  afterHoursMessageGu: text(160),
  deliveryPromiseEn: text(120),
  deliveryPromiseGu: text(120),
  minimumAppVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'Use the format 1.0.0.'),
  maintenanceMode: z.boolean(),
  maintenanceMessageEn: text(200),
  maintenanceMessageGu: text(200),
  showMaintenanceContact: z.boolean(),
  flags: featureFlagsSchema,
}).superRefine((value, context) => {
  if (value.callEnabled && !value.supportPhone) context.addIssue({ code: 'custom', path: ['supportPhone'], message: 'Add a support phone number to turn calling on.' })
  if (value.whatsappEnabled && !value.supportWhatsApp) context.addIssue({ code: 'custom', path: ['supportWhatsApp'], message: 'Add a WhatsApp number to turn WhatsApp on.' })
  if (value.maintenanceMode && !value.maintenanceMessageEn) context.addIssue({ code: 'custom', path: ['maintenanceMessageEn'], message: 'Tell customers why the app is unavailable.' })
  if (value.showMaintenanceContact && !value.supportPhone && !value.supportEmail && !value.supportWhatsApp) context.addIssue({ code: 'custom', path: ['showMaintenanceContact'], message: 'Add a support phone, email or WhatsApp number first.' })
})

export type AppSettingsInput = z.infer<typeof appSettingsSchema>
export type FeatureFlags = z.infer<typeof featureFlagsSchema>
