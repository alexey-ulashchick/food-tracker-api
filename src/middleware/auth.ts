import { createMiddleware } from 'hono/factory'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AuthEnv = { Variables: { userId: string } }

// Dev-grade auth: trust the X-User-Id header. Server upserts a user row keyed
// on the supplied UUID. Real auth (Sign in with Apple / magic-link) replaces
// this whole middleware once the iOS client gains a login flow.
export const auth = createMiddleware<AuthEnv>(async (c, next) => {
  const userId = c.req.header('X-User-Id')

  if (!userId || !UUID_RE.test(userId)) {
    return c.json(
      { error: 'Missing or malformed X-User-Id header (must be a UUID)' },
      401,
    )
  }

  await db.insert(users).values({ id: userId }).onConflictDoNothing({ target: users.id })

  c.set('userId', userId)
  await next()
})
