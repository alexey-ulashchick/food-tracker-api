#!/usr/bin/env bun
//
// Issues a long-lived bearer token for the MCP /mcp/:token endpoint.
// Use this to wire up the mobile Claude app, which can't inject custom
// headers — the token IS the credential, embedded in the URL.
//
// Usage:
//   bun scripts/issue-token.ts --user <uuid> [--label "iPhone Claude"]
//   bun run issue-token -- --user <uuid> [--label "iPhone Claude"]
//   bun run issue-token:neon -- --user <uuid>     # against Neon
//
// The script prints the plaintext token ONCE — there is no recovery.
// If you lose it, revoke (UPDATE api_tokens SET revoked_at = now() WHERE …)
// and issue a new one.

import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import { apiTokens, users } from '../src/db/schema.ts'

const args = process.argv.slice(2)
let userId: string | undefined
let label: string | undefined

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--user' || a === '-u') userId = args[++i]
  else if (a === '--label' || a === '-l') label = args[++i]
  else if (a === '--help' || a === '-h') {
    printUsage()
    process.exit(0)
  }
}

if (!userId) {
  printUsage()
  process.exit(1)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!UUID_RE.test(userId)) {
  console.error(`Invalid UUID: ${userId}`)
  process.exit(1)
}

// Ensure the user row exists — same upsert the auth middleware does, so
// you can issue a token for a brand-new userId without first hitting the API.
await db.insert(users).values({ id: userId }).onConflictDoNothing({ target: users.id })

const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
if (!user) {
  console.error(`Failed to find or create user ${userId}`)
  process.exit(1)
}

// 32 random bytes → 64 hex chars, prefixed with `ft_` so it's recognizable
// in logs ("food-tracker") and the auth middleware can fast-reject malformed
// inputs without a DB hit.
const bytes = new Uint8Array(32)
crypto.getRandomValues(bytes)
const token = `ft_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`

await db.insert(apiTokens).values({ token, userId, label: label ?? null })

console.log()
console.log('Issued MCP token:')
console.log()
console.log(`  ${token}`)
console.log()
console.log('Use it as the URL in your Claude connector:')
console.log()
console.log(`  https://food-tracker-api-oc5olq.fly.dev/mcp/${token}`)
console.log()
console.log('Or against localhost during development:')
console.log()
console.log(`  http://localhost:3000/mcp/${token}`)
console.log()
console.log('Anyone with this URL can act as user', userId)
console.log('Store it like a password.')

process.exit(0)

function printUsage() {
  console.log('Usage:')
  console.log('  bun scripts/issue-token.ts --user <uuid> [--label <name>]')
  console.log()
  console.log('Options:')
  console.log('  --user, -u   Target user UUID (required)')
  console.log('  --label, -l  Free-text label, e.g. "iPhone Claude" (optional)')
}
