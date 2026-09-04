// Serves the built SPA from the same origin as the API. Because the bundle and
// the API share an origin, the app needs no CORS middleware and the browser
// sends no preflights — in dev the same illusion is produced by Vite's proxy
// (see vite.config.ts).
//
// Two pieces, mounted at opposite ends of src/index.ts:
//   * `spaNavigation` goes FIRST, and claims the handful of client-side routes
//     whose paths also exist as API endpoints.
//   * `staticRoute` goes LAST, so every API route wins before the catch-all
//     falls through to index.html.

import type { Context, Next } from 'hono'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

// Relative to the process CWD: /app in the container, the repo root locally.
const DIST = './web/dist'

const immutable = (_path: string, c: { header: (k: string, v: string) => void }) => {
  c.header('Cache-Control', 'public, max-age=31536000, immutable')
}

const indexHtml = serveStatic({
  path: `${DIST}/index.html`,
  onFound: (_path, c) => {
    c.header('Cache-Control', 'no-cache')
  },
  onNotFound: (path) => {
    console.warn(`[static] ${path} is missing — run "bun run web:build"`)
  },
})

/**
 * Client-side routes that collide with an API path of the same name.
 *
 * `/chat` is both: the web app's chat screen, and the endpoint the iOS client
 * calls for history. Renaming either would be worse — the screen's URL should
 * read `/chat`, and the iOS build in the field cannot be changed. So the two are
 * told apart by what the caller asks for: a browser navigation sends
 * `Accept: text/html`, while fetch() and URLSession both default to accepting
 * anything.
 *
 * Anything NOT listed here needs no negotiation, because no API route shadows
 * it and the trailing catch-all already serves it.
 */
const COLLIDING_SPA_ROUTES = ['/chat'] as const

export const spaNavigation = new Hono()

for (const path of COLLIDING_SPA_ROUTES) {
  spaNavigation.get(path, async (c: Context, next: Next) => {
    const accept = c.req.header('Accept') ?? ''
    if (!accept.includes('text/html')) return next()
    return indexHtml(c, next)
  })
}

export const staticRoute = new Hono()
  // Vite content-hashes everything under /assets, so it is safe to cache
  // forever. index.html must never be cached, or a deploy leaves clients
  // pinned to a stale bundle whose hashed assets no longer exist.
  .use('/assets/*', serveStatic({ root: DIST, onFound: immutable }))
  .use('/icons/*', serveStatic({ root: DIST, onFound: immutable }))
  .use('/manifest.webmanifest', serveStatic({ root: DIST }))
  .use('/apple-touch-icon.png', serveStatic({ root: DIST }))
  .use('/favicon.ico', serveStatic({ root: DIST }))
  // SPA fallback. GET only: an unmatched POST/PUT should still 404 rather than
  // hand the caller a page of HTML.
  .get('*', indexHtml)
