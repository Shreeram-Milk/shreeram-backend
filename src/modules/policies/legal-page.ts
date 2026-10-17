import type { PublicPolicy } from './service.js'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string)

/** Plain text to paragraphs: a blank line starts a new paragraph, a single line break stays a line break. Everything is escaped. */
const paragraphs = (body: string) => body.split(/\r?\n\s*\r?\n/).map(part => part.trim()).filter(Boolean).map(part => `<p>${escapeHtml(part).replace(/\r?\n/g, '<br>')}</p>`).join('\n')

const STYLE = `body{margin:0;background:#faf8f5;color:#1f2933;font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Gujarati",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:26px;line-height:1.3;margin:8px 0 4px}
.meta{color:#5b6670;font-size:14px;margin:0 0 24px}
nav{display:flex;gap:8px;margin-bottom:8px}
nav a{padding:6px 14px;border:1px solid #d8d2c8;border-radius:999px;color:#7a3b0c;text-decoration:none;font-size:14px}
nav a[aria-current=true]{background:#7a3b0c;color:#fff;border-color:#7a3b0c}
p{margin:0 0 16px}`

/**
 * The public web page for one published policy, in English or Gujarati. The app stores require a link anyone can open
 * (not a PDF), and this is it. Text is escaped, so a policy can never inject markup into the page.
 */
export function renderLegalPage(policy: PublicPolicy, language: 'en' | 'gu'): string {
  const useGujarati = language === 'gu' && policy.bodyGu.trim() !== ''
  const title = useGujarati && policy.titleGu.trim() ? policy.titleGu : policy.titleEn
  const body = useGujarati ? policy.bodyGu : policy.bodyEn
  const base = `/legal/${policy.type}`
  return `<!doctype html>
<html lang="${useGujarati ? 'gu' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ShreeRam Milks</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<nav aria-label="Language"><a href="${base}?lang=en"${useGujarati ? '' : ' aria-current="true"'}>English</a><a href="${base}?lang=gu"${useGujarati ? ' aria-current="true"' : ''}>ગુજરાતી</a></nav>
<h1>${escapeHtml(title)}</h1>
<p class="meta">ShreeRam Milks · Version ${escapeHtml(policy.version)} · Effective ${escapeHtml(policy.effectiveDate)}</p>
${paragraphs(body)}
</main>
</body>
</html>`
}

/** Shown when a policy has no published version, so a store reviewer or customer sees a clear page, not a blank one. */
export function renderLegalNotFound(title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} — ShreeRam Milks</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p class="meta">ShreeRam Milks</p><p>This document is not available right now. Please check back soon.</p></main></body></html>`
}
