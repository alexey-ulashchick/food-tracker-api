import { afterAll, mock } from 'bun:test'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'

// ─── env defaults ──────────────────────────────────────────────────────────
// env.ts validates at import-time. The mocked SDK never reads the key, but
// validation still expects a non-empty string.
process.env.ANTHROPIC_API_KEY ??= 'test-key-unused'
process.env.NODE_ENV ??= 'test'

// ─── per-process random schema ─────────────────────────────────────────────
// Picked once per test process. db/client.ts reads TEST_SCHEMA and routes all
// queries to it via Postgres `search_path`. Dropped CASCADE in afterAll.
const TEST_SCHEMA = `test_${randomBytes(6).toString('hex')}`
process.env.TEST_SCHEMA = TEST_SCHEMA

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://food:food@localhost:5432/food'

// ─── Safety guard ──────────────────────────────────────────────────────────
// Tests provision a random schema and TRUNCATE freely inside it. If the
// DATABASE_URL ever points at a real (remote) database — production, Neon,
// staging — those operations will run there. This guard refuses to start
// against anything that isn't localhost. Override only if you have a
// disposable test database and you really mean it: ALLOW_REMOTE_TESTS=1.
//
// Why so loud: a previous run wiped real api_tokens via TRUNCATE … CASCADE
// when the URL accidentally pointed at the remote DB. Hard-fail is cheap;
// recovering data from a backup is not.
{
  const host = (() => {
    try {
      return new URL(DATABASE_URL).hostname
    } catch {
      return ''
    }
  })()
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!isLocal && process.env.ALLOW_REMOTE_TESTS !== '1') {
    throw new Error(
      `Refusing to run tests against non-local DATABASE_URL (host=${host || '?'}). ` +
        'Tests provision a fresh schema and TRUNCATE inside it — running this against ' +
        'a real database can wipe data via FK CASCADE. ' +
        'Point DATABASE_URL at a local Postgres, or set ALLOW_REMOTE_TESTS=1 if you ' +
        'truly want to run against a disposable remote.',
    )
  }
}

// ─── Anthropic SDK mock ────────────────────────────────────────────────────
// Tests configure responses via messagesCreate.mockResolvedValueOnce(...).
// The default (unconfigured) call throws so missing setup fails loudly instead
// of silently calling the real API.
export const messagesCreate = mock(async () => {
  throw new Error(
    'messagesCreate was called without a mocked response — ' +
      'set one with messagesCreate.mockResolvedValueOnce(...) in your test',
  )
})

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate }
  },
}))

// ─── DDL bootstrap ─────────────────────────────────────────────────────────
// Single connection so SET search_path persists across the DDL statements.
const root = postgres(DATABASE_URL, { max: 1 })

await root.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`)
await root.unsafe(`SET search_path TO "${TEST_SCHEMA}"`)
const initSql = await Bun.file(new URL('./init.sql', import.meta.url)).text()
await root.unsafe(initSql)
await root.end()

// ─── teardown ──────────────────────────────────────────────────────────────
// Bun runs preload-level afterAll once at the end of the suite per process.
// We use a fresh connection because the bootstrap pool is closed.
afterAll(async () => {
  const cleanup = postgres(DATABASE_URL, { max: 1 })
  try {
    await cleanup.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
  } finally {
    await cleanup.end()
  }
})
