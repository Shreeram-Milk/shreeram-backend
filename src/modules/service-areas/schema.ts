import { z } from 'zod'
import { RECORD_STATUSES, descriptionField, nameField } from '../master-data/shared.js'

export const COVERAGE_TYPES = ['pin_code', 'state', 'pan_india'] as const
export const MAX_BULK_PINS = 500
const PIN_CODE = /^[1-9][0-9]{5}$/

const place = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default('')

/**
 * What an area must name depends on its kind: a PIN-code area names a state and city, a whole-state area names its state,
 * and an all-India area names neither (anything sent is dropped, so a stale value cannot linger).
 */
export const serviceAreaInputSchema = z.object({
  name: nameField,
  description: descriptionField,
  coverageType: z.enum(COVERAGE_TYPES),
  state: place(60),
  city: place(60),
  status: z.enum(RECORD_STATUSES).default('active'),
  /** The admin's "yes" to deleting the PIN codes when a PIN-code area is changed to another kind. */
  confirmRemovePins: z.boolean().default(false),
}).superRefine((area, context) => {
  if (area.coverageType !== 'pan_india' && !area.state) context.addIssue({ code: 'custom', path: ['state'], message: 'Enter the state.' })
  if (area.coverageType === 'pin_code' && !area.city) context.addIssue({ code: 'custom', path: ['city'], message: 'Enter the city.' })
}).transform(area => ({
  ...area,
  state: area.coverageType === 'pan_india' ? '' : area.state,
  city: area.coverageType === 'pin_code' ? area.city : '',
}))

const pinCodeField = z.string().trim().regex(PIN_CODE, 'Enter a valid 6-digit Indian PIN code.')
const slotIdsField = z.array(z.uuid('Choose a delivery slot.')).min(1, 'Choose at least one delivery slot.').max(20)
  .transform(ids => [...new Set(ids)])

export const pinInputSchema = z.object({
  pinCode: pinCodeField,
  locality: z.string().trim().max(80, 'Keep the locality under 80 characters.').default(''),
  allowedDeliverySlotIds: slotIdsField,
  status: z.enum(RECORD_STATUSES).default('active'),
})

/** "Paste many": the same slots and locality for every PIN in the list. */
export const bulkPinInputSchema = z.object({
  pinCodes: z.array(pinCodeField).min(1, 'Add at least one PIN code.').max(MAX_BULK_PINS, `Add at most ${MAX_BULK_PINS} PIN codes at a time.`).transform(codes => [...new Set(codes)]),
  locality: z.string().trim().max(80, 'Keep the locality under 80 characters.').default(''),
  /** Optional own locality for particular PINs (for example the post office names from the PIN directory); other PINs use `locality`. */
  localities: z.record(pinCodeField, z.string().trim().max(80, 'Keep the locality under 80 characters.')).refine(map => Object.keys(map).length <= MAX_BULK_PINS, `Add at most ${MAX_BULK_PINS} localities.`).default({}),
  allowedDeliverySlotIds: slotIdsField,
  status: z.enum(RECORD_STATUSES).default('active'),
})

export const pinParamsSchema = z.object({ id: z.uuid('That is not a valid id.'), pinId: z.uuid('That is not a valid PIN id.') })
export const pinListQuerySchema = z.object({
  search: z.string().trim().max(100).default(''),
  status: z.enum(RECORD_STATUSES).optional(),
  slotId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type ServiceAreaInput = z.infer<typeof serviceAreaInputSchema>
export type CoverageType = (typeof COVERAGE_TYPES)[number]
export type PinInput = z.infer<typeof pinInputSchema>
export type BulkPinInput = z.infer<typeof bulkPinInputSchema>
export type PinListQuery = z.infer<typeof pinListQuerySchema>
