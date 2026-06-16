import { and, eq, isNull, sql } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { db } from '../db/client.ts'
import { apiTokens } from '../db/schema.ts'
import type { AuthEnv } from './auth.ts'

const TOKEN_RE = /^ft_[0-9a-f]{64}$/

// Looks up :token from the URL path. Used by /mcp/:token where mobile Claude
// (which can't inject custom headers) authenticates by URL alone. Updates
// last_used_at on every successful hit.
export const tokenAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = c.req.param('token')

  if (!token || !TOKEN_RE.test(token)) {
    return c.json({ error: 'Missing or malformed token' }, 401)
  }

  const [row] = await db
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.token, token), isNull(apiTokens.revokedAt)))
    .limit(1)

  if (!row) {
    return c.json({ error: 'Invalid or revoked token' }, 401)
  }

  // Fire-and-forget: bumping last_used_at shouldn't block the request, and a
  // failed UPDATE here doesn't change the auth outcome.
  db.update(apiTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiTokens.token, token))
    .catch(() => {})

  c.set('userId', row.userId)
  await next()
})
