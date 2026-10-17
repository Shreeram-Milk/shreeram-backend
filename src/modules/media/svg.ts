/**
 * An SVG is a small program as well as a picture: it can carry scripts. Icons are therefore checked after upload and
 * refused if they contain anything that is not plain drawing. Real artwork never needs these.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/<\s*script/i, 'scripts'],
  [/\son[a-z]+\s*=/i, 'event handlers'],
  [/javascript\s*:/i, 'javascript links'],
  [/<\s*(foreignObject|iframe|embed|object|audio|video)/i, 'embedded content'],
  [/<!\s*(DOCTYPE|ENTITY)/i, 'entity declarations'],
  [/href\s*=\s*["']\s*(?!#)/i, 'links to other files'],
  [/url\(\s*["']?\s*(?!#)/i, 'links to other files'],
  [/@import/i, 'style imports'],
]

/** Returns what is wrong with the SVG text, or null when it is plain drawing. */
export function svgProblem(text: string): string | null {
  if (!/<\s*svg[\s>]/i.test(text)) return 'It is not an SVG file.'
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) return `It contains ${what}.`
  return null
}
