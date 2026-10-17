export type Language = 'en' | 'gu'

/** The wording of a message in both languages. Gujarati may be left empty; English is then used. */
export type Wording = { title: string; titleGujarati: string; body: string; bodyGujarati: string }

/** Replaces `{{name}}` in the wording with the real value; a name with no value becomes empty text. */
export const renderTemplate = (text: string, vars: Record<string, string>): string => text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '').replace(/ {2,}/g, ' ').trim()

/** The title and body to show someone who reads `language`, falling back to English for anything left empty. */
export function pickLanguage(wording: Wording, language: Language): { title: string; body: string } {
  if (language !== 'gu') return { title: wording.title, body: wording.body }
  return { title: wording.titleGujarati || wording.title, body: wording.bodyGujarati || wording.body }
}

/** Whole rupees without decimals, otherwise two decimals, with Indian digit grouping: 125000 paise -> "₹1,250". */
export function formatRupees(paise: number): string {
  const rupees = paise / 100
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`
}

/** "2026-10-17" -> "Sat 17 Oct", read as a plain calendar date (no timezone shift). */
export function formatDay(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')
}

/** The same day for the Gujarati wording: "2026-10-17" -> "શનિ, 17 ઑક્ટો". */
export function formatDayGujarati(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('gu-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** The only screens a tapped message may open. Anything else is dropped, so a message can never send the app somewhere unexpected. */
const ALLOWED_LINKS = ['/order-tracking?orderId=', '/subscription-manage?id=', '/orders', '/subscriptions', '/notifications', '/offers'] as const
export function safeLink(link: string | null | undefined): string | null {
  return link && ALLOWED_LINKS.some(prefix => link.startsWith(prefix)) && !/\s/.test(link) && link.length <= 200 ? link : null
}
