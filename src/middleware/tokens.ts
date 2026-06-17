import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { apiTokens } from '../db/schema.ts'

const TOKEN_RE = /^ft_[0-9a-f]{64}$/

// Resolves a bearer token to a userId. Returns null for malformed, unknown,
// or revoked tokens. Updates last_used_at fire-and-forget so the auth path
// stays a single round-trip in the happy case.
export async function lookupToken(token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null

  const [row] = await db
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.token, token), isNull(apiTokens.revokedAt)))
    .limit(1)

  if (!row) return null

  db.update(apiTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiTokens.token, token))
    .catch(() => {})

  return row.userId
}
