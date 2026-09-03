import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../src/db/client.ts'
import { apiTokens, dailyGoals, meals, users } from '../src/db/schema.ts'
import { chatRoute } from '../src/routes/chat.ts'

export type App = ReturnType<typeof makeApp>

export function makeApp() {
  return new Hono().route('/chat', chatRoute)
}

// Single TRUNCATE wipes everything; CASCADE handles FKs; RESTART IDENTITY
// resets sequences. Faster than per-table deletes.
export async function truncateAll(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE chat_messages, meals, daily_goals, api_tokens, users RESTART IDENTITY CASCADE`,
  )
}

export const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
})

// Seeds a user row + freshly-minted API token. Returns both because some tests
// assert against the userId in response payloads while still needing the
// token for the Authorization header.
export async function seedUser(): Promise<{ userId: string; token: string }> {
  const userId = crypto.randomUUID()
  await db.insert(users).values({ id: userId }).onConflictDoNothing()

  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = `ft_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
  await db.insert(apiTokens).values({ token, userId })

  return { userId, token }
}

export async function seedMeal(
  userId: string,
  overrides: Partial<typeof meals.$inferInsert> = {},
): Promise<typeof meals.$inferSelect> {
  const [row] = await db
    .insert(meals)
    .values({
      userId,
      meal: 'Lunch',
      foodName: 'Test meal',
      calories: 500,
      protein: 30,
      carbs: 50,
      fats: 10,
      ...overrides,
    })
    .returning()
  return row!
}

export async function seedGoal(
  userId: string,
  overrides: Partial<typeof dailyGoals.$inferInsert> = {},
): Promise<typeof dailyGoals.$inferSelect> {
  const [row] = await db
    .insert(dailyGoals)
    .values({
      userId,
      date: '2026-06-17',
      dayType: 'rest',
      calorieGoal: 2200,
      proteinGGoal: 160,
      carbsGGoal: 230,
      fatGGoal: 70,
      ...overrides,
    })
    .returning()
  return row!
}

// Builds a canned Anthropic Messages API response. Only the fields runToolLoop
// reads are populated; the rest are minimal stubs that satisfy the SDK type.
export function llmResponse(args: {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
}) {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'mock',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...args,
  }
}

export type SseEvent = { event: string; data: Record<string, unknown> }

// Parses an SSE response body into typed events. Comment frames (the
// heartbeat POST /chat/stream sends) are skipped, matching what an
// EventSource client does.
export async function readSse(res: Response): Promise<SseEvent[]> {
  const body = await res.text()
  const events: SseEvent[] = []
  for (const frame of body.split('\n\n')) {
    if (!frame.trim() || frame.trimStart().startsWith(':')) continue
    const event = /^event:\s*(.*)$/m.exec(frame)?.[1]
    const data = /^data:\s*([\s\S]*)$/m.exec(frame)?.[1]
    if (event && data !== undefined) events.push({ event, data: JSON.parse(data) })
  }
  return events
}

// POST /chat/stream with a multipart body, the way the web client sends it.
export function streamRequest(token: string, content: string, extra: Record<string, string> = {}) {
  const form = new FormData()
  form.set('content', content)
  for (const [k, v] of Object.entries(extra)) form.set(k, v)
  return new Request('http://x/chat/stream', {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  })
}
