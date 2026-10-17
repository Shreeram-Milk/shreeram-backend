import { z } from 'zod'
import { RECORD_STATUSES, descriptionField, nameField, timeField } from '../master-data/shared.js'

export const deliverySlotInputSchema = z.object({
  name: nameField,
  description: descriptionField,
  startTime: timeField,
  endTime: timeField,
  status: z.enum(RECORD_STATUSES).default('active'),
}).refine(slot => slot.endTime > slot.startTime, { path: ['endTime'], message: 'The end time must be after the start time.' })

export type DeliverySlotInput = z.infer<typeof deliverySlotInputSchema>
