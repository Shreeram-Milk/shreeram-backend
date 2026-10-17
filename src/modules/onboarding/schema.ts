import { z } from 'zod'

/** The introduction stays short; more than this and people skip it. */
export const MAX_ACTIVE_SLIDES = 5
export const SLIDE_STATUSES = ['active', 'inactive'] as const

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`)

/** One screen of the first-run introduction: a picture, a headline and a line of text, in both languages. */
export const slideInputSchema = z.object({
  imageAssetId: z.uuid('Choose a picture.'),
  titleEn: text(80).min(1, 'Enter the headline.'),
  titleGu: text(80).default(''),
  descriptionEn: text(200).min(1, 'Enter the text.'),
  descriptionGu: text(200).default(''),
  status: z.enum(SLIDE_STATUSES).default('active'),
})
export const slideStatusSchema = z.object({ status: z.enum(SLIDE_STATUSES) })
export const slideMoveSchema = z.object({ direction: z.enum(['up', 'down']) })
export const slideIdParamsSchema = z.object({ id: z.uuid('That is not a valid slide id.') })

export type SlideInput = z.infer<typeof slideInputSchema>
export type SlideStatus = (typeof SLIDE_STATUSES)[number]
