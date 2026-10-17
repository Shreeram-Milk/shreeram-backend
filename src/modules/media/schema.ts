import { z } from 'zod'

/**
 * `banner` is a promotion photo, `banner_icon` is the small SVG on a Maintenance or Information notice,
 * `onboarding` is a picture on a first-run introduction slide, `product` is a photo of something you sell.
 */
export const MEDIA_PURPOSES = ['banner', 'banner_icon', 'onboarding', 'product'] as const
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'] as const

export type MediaPurpose = (typeof MEDIA_PURPOSES)[number]
export type ImageType = (typeof IMAGE_TYPES)[number]

const PHOTO_TYPES: readonly ImageType[] = ['image/jpeg', 'image/png', 'image/webp']
const KB = 1024

/** What each purpose accepts. Photos are real pictures; icons are tiny SVG drawings. */
export const MEDIA_RULES: Record<MediaPurpose, { types: readonly ImageType[]; maxBytes: number; typeMessage: string; sizeMessage: string }> = {
  banner: { types: PHOTO_TYPES, maxBytes: 2 * KB * KB, typeMessage: 'Use a JPEG, PNG or WebP picture.', sizeMessage: 'Keep the picture under 2 MB.' },
  product: { types: PHOTO_TYPES, maxBytes: 2 * KB * KB, typeMessage: 'Use a JPEG, PNG or WebP picture.', sizeMessage: 'Keep the picture under 2 MB.' },
  onboarding: { types: PHOTO_TYPES, maxBytes: 2 * KB * KB, typeMessage: 'Use a JPEG, PNG or WebP picture.', sizeMessage: 'Keep the picture under 2 MB.' },
  banner_icon: { types: ['image/svg+xml'], maxBytes: 100 * KB, typeMessage: 'Icons must be SVG files.', sizeMessage: 'Keep the icon under 100 KB.' },
}

export const uploadRequestSchema = z.object({
  purpose: z.enum(MEDIA_PURPOSES),
  contentType: z.enum(IMAGE_TYPES, 'Use a JPEG, PNG, WebP or SVG file.'),
  sizeBytes: z.number().int('Use a whole number.').min(1, 'The file is empty.'),
}).superRefine((value, context) => {
  const rule = MEDIA_RULES[value.purpose]
  if (!rule.types.includes(value.contentType)) context.addIssue({ code: 'custom', path: ['contentType'], message: rule.typeMessage })
  if (value.sizeBytes > rule.maxBytes) context.addIssue({ code: 'custom', path: ['sizeBytes'], message: rule.sizeMessage })
})
export const mediaIdParamsSchema = z.object({ id: z.uuid('That is not a valid picture id.') })

export type UploadRequest = z.infer<typeof uploadRequestSchema>
