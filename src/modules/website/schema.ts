import { z } from 'zod'

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default('')
const required = (max: number, message: string) => z.string().trim().min(1, message).max(max, `Keep this under ${max} characters.`)
/** Empty, or an https link (the website only shows secure links and pictures). */
const httpsLink = z.string().trim().max(500, 'This link is too long.').default('').refine(value => value === '' || /^https:\/\/[^\s]+$/.test(value), 'Use a full link starting with https://')

const card = z.object({ title: required(40, 'Add a short title.'), text: required(160, 'Add one line about it.') })

/**
 * The website Home page, as staff edit it. Only the words and links change here: the page's layout, the other pages and the
 * policies are fixed in the website (policies come from Legal & Policies, contact details from App Settings).
 */
export const websiteHomeSchema = z.object({
  /** An optional thin line across the top of the page, for example "Now delivering in Gandhinagar". */
  announcement: text(140),
  heroTitle: required(80, 'Add the main heading.'),
  heroSubtitle: text(240),
  heroImageUrl: httpsLink,
  highlights: z.array(card).max(4, 'Up to 4 highlights.'),
  steps: z.array(card).max(4, 'Up to 4 steps.'),
  showProducts: z.boolean(),
  productsTitle: text(60),
  ctaTitle: text(80),
  ctaText: text(200),
  playStoreUrl: httpsLink,
  /** What Google shows for the Home page. */
  seoTitle: required(70, 'Add the title Google shows.'),
  seoDescription: required(170, 'Add the line Google shows under the title.'),
})

export type WebsiteHomeInput = z.infer<typeof websiteHomeSchema>
