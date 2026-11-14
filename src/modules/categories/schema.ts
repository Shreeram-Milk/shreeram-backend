import { z } from 'zod'
import { RECORD_STATUSES } from '../master-data/shared.js'

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(40, 'Keep the name under 40 characters.'),
  nameGu: z.string().trim().max(40, 'Keep the Gujarati name under 40 characters.').default(''),
  description: z.string().trim().max(200, 'Keep the description under 200 characters.').default(''),
  sortOrder: z.number().int('Use a whole number.').min(0, 'Use zero or greater.').max(10_000).default(0),
  status: z.enum(RECORD_STATUSES).default('active'),
  /** The tile picture, uploaded first with purpose `category`. None: the app shows a plain tile. */
  imageAssetId: z.uuid('That is not a valid picture.').nullable().default(null),
})

export type CategoryInput = z.infer<typeof categoryInputSchema>
