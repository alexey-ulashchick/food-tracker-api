import { createMiddleware } from 'hono/factory'
import { lookupToken } from './tokens.ts'

const BEARER_RE = /^Bearer\s+(\S+)$/i

export type AuthEnv = { Variables: { userId: string } }

// Bearer-token auth. The token is minted via scripts/issue-token.ts and
// resolved against api_tokens — same lookup the /mcp/:token route uses, so
// REST and MCP share a single credential surface.
export const auth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header) {
    return c.json({ error: 'Missing Authorization header' }, 401)
  }

  const m = BEARER_RE.exec(header)
  if (!m) {
    return c.json({ error: 'Authorization header must be "Bearer <token>"' }, 401)
  }

  const userId = await lookupToken(m[1]!)
  if (!userId) {
    return c.json({ error: 'Invalid or revoked token' }, 401)
  }

  c.set('userId', userId)
  await next()
})
