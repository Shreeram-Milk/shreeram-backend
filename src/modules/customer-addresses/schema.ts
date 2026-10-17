import { z } from 'zod'
import { phoneSchema } from '../customer-auth/schema.js'
import { recordIdParamsSchema } from '../master-data/shared.js'

export const ADDRESS_LABELS = ['home', 'work', 'other'] as const
export const MAX_ADDRESSES_PER_CUSTOMER = 10

/** Everything the customer sends to save an address. Anything not listed here is dropped, never stored. */
export const addressInputSchema = z.object({
  label: z.enum(ADDRESS_LABELS).default('home'),
  recipientName: z.string().trim().min(1, 'Enter the name of the person receiving the delivery.').max(100),
  recipientPhone: phoneSchema,
  line1: z.string().trim().min(1, 'Enter your house, flat or block number.').max(150),
  line2: z.string().trim().max(150).default(''),
  landmark: z.string().trim().max(150).default(''),
  city: z.string().trim().max(80).default(''),
  pinCode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit PIN code.'),
  isDefault: z.boolean().default(false),
})
export type AddressInput = z.infer<typeof addressInputSchema>

export const doorstepInstructionsSchema = z.object({
  dropLocation: z.enum(['front-door', 'side-gate', 'milk-box', 'security-desk']),
  handoff: z.enum(['hand-to-me', 'leave-at-door', 'milk-box', 'security']),
  noDoorbell: z.boolean(),
  noCall: z.boolean(),
  notifyAfterDelivery: z.boolean(),
  additionalInstructions: z.string().trim().max(300).default(''),
})
export type DoorstepInstructions = z.infer<typeof doorstepInstructionsSchema>

export const DEFAULT_DOORSTEP_INSTRUCTIONS: DoorstepInstructions = {
  dropLocation: 'front-door', handoff: 'leave-at-door', noDoorbell: true, noCall: false, notifyAfterDelivery: true, additionalInstructions: '',
}

export { recordIdParamsSchema }
