import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../src/db/client.ts'
import { dailyGoals, meals, users } from '../src/db/schema.ts'
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

// Seed a user row directly. The auth middleware would also do this on first
// request, but tests that pre-seed meals (FK requires the user) need it
// up-front.
export async function seedUser(): Promise<string> {
  const userId = crypto.randomUUID()
  await db.insert(users).values({ id: userId }).onConflictDoNothing()
  return userId
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
