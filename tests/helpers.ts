import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../src/db/client.ts'
import { chatMessages, users } from '../src/db/schema.ts'
import { chatRoute } from '../src/routes/chat.ts'

export type App = ReturnType<typeof makeApp>

export function makeApp() {
  return new Hono().route('/chat', chatRoute)
}

// Single TRUNCATE wipes everything; CASCADE handles FKs; RESTART IDENTITY
// resets sequences. Faster than per-table deletes.
export async function truncateAll(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE chat_messages, meals, daily_goals, users RESTART IDENTITY CASCADE`,
  )
}

export const authHeaders = (userId: string): Record<string, string> => ({
  'X-User-Id': userId,
})

// Seed a user row directly (the auth middleware would also do this on first
// request, but for /chat/confirm tests we need a card row to exist before any
// HTTP call, and the FK requires the user first).
export async function seedUser(): Promise<string> {
  const userId = crypto.randomUUID()
  await db.insert(users).values({ id: userId }).onConflictDoNothing()
  return userId
}

export async function seedFoodCard(
  userId: string,
  meta: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      userId,
      role: 'ai',
      kind: 'food_card',
      content: typeof meta.foodName === 'string' ? meta.foodName : 'card',
      meta,
    })
    .returning({ id: chatMessages.id })
  return row!.id
}

export async function seedGoalCard(
  userId: string,
  meta: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      userId,
      role: 'ai',
      kind: 'goal_card',
      content: 'goal card',
      meta,
    })
    .returning({ id: chatMessages.id })
  return row!.id
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
