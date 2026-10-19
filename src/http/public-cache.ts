import type { Response } from 'express'

/** How long public content is reused by phones, and by a CDN once there is one. Also the server's own memory time. With the same
 * stale-while-revalidate time, nothing public is ever older than one minute, so admin changes show up within a minute. */
export const PUBLIC_CACHE_SECONDS = 30

/** The same short shared cache, for a public web page. */
export function sendPublicHtml(response: Response, html: string): void {
  response.setHeader('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}, stale-while-revalidate=${PUBLIC_CACHE_SECONDS}`)
  response.type('html').send(html)
}

/**
 * Sends public, non-personal content with a short shared cache. Every other response stays `no-store` (set for the whole
 * API), and this is only called on success, so an error is never cached. Never use it for anything personal.
 */
export function sendPublic(response: Response, body: unknown): void {
  response.setHeader('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}, stale-while-revalidate=${PUBLIC_CACHE_SECONDS}`)
  response.json(body)
}
