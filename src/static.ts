// Serves the built SPA from the same origin as the API. Registered LAST in
// src/index.ts so every API route wins before the catch-all falls through to
// index.html. Because the bundle and the API share an origin, the app needs no
// CORS middleware and the browser sends no preflights — in dev the same
// illusion is produced by Vite's proxy (see vite.config.ts).

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

// Relative to the process CWD: /app in the container, the repo root locally.
const DIST = './web/dist'

const immutable = (_path: string, c: { header: (k: string, v: string) => void }) => {
  c.header('Cache-Control', 'public, max-age=31536000, immutable')
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
  // SPA fallback. GET only: an unmatched POST/PUT should still 404 rather
  // than hand the caller a page of HTML.
  .get(
    '*',
    serveStatic({
      path: `${DIST}/index.html`,
      onFound: (_path, c) => {
        c.header('Cache-Control', 'no-cache')
      },
      onNotFound: (path) => {
        console.warn(`[static] ${path} is missing — run "bun run web:build"`)
      },
    }),
  )
