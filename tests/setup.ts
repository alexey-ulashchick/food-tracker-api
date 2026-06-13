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
