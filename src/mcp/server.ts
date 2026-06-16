import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, desc, eq, gte, lt, lte } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { dailyGoals, meals } from '../db/schema.ts'

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .describe('Calendar date in YYYY-MM-DD format')

// One-day [start, end) window from a YYYY-MM-DD string in the server's TZ.
function dayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00`)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

// Builds a fresh McpServer scoped to a single authenticated user. We re-build
// per request so userId is captured by closure and tool handlers don't have to
// thread auth context through.
export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: 'food-tracker',
    version: '0.1.0',
  })

  server.registerTool(
    'list_meals',
    {
      title: 'List meals',
      description:
        "List the user's meals, newest first. Use `from`/`to` (ISO 8601) to bound the range; both optional.",
      inputSchema: {
        from: z.string().datetime().optional().describe('ISO 8601 lower bound (inclusive).'),
        to: z.string().datetime().optional().describe('ISO 8601 upper bound (inclusive).'),
        limit: z.number().int().positive().max(500).default(100),
      },
    },
    async ({ from, to, limit }) => {
      const conditions = [eq(meals.userId, userId)]
      if (from) conditions.push(gte(meals.timestamp, new Date(from)))
      if (to) conditions.push(lte(meals.timestamp, new Date(to)))
      const rows = await db
        .select()
        .from(meals)
        .where(and(...conditions))
        .orderBy(desc(meals.timestamp))
        .limit(limit)
      return ok(rows)
    },
  )

  server.registerTool(
    'get_meals_for_day',
    {
      title: 'Get meals for a calendar day',
      description: 'Every meal logged on a specific calendar date, in chronological order.',
      inputSchema: { date: isoDate },
    },
    async ({ date }) => {
      const { start, end } = dayBounds(date)
      const rows = await db
        .select()
        .from(meals)
        .where(and(eq(meals.userId, userId), gte(meals.timestamp, start), lt(meals.timestamp, end)))
        .orderBy(meals.timestamp)
      return ok(rows)
    },
  )

  server.registerTool(
    'create_meal',
    {
      title: 'Log a meal',
      description: 'Insert a new meal entry. `timestamp` defaults to now if omitted.',
      inputSchema: {
        timestamp: z
          .string()
          .datetime()
          .optional()
          .describe('ISO 8601 when the food was eaten. Server fills "now" if omitted.'),
        meal: z.enum(['Breakfast', 'Lunch', 'Dinner', 'Snack']),
        emoji: z.string().nullish().describe('Single food emoji.'),
        foodName: z.string().min(1).max(200),
        calories: z.number().nonnegative(),
        protein: z.number().nonnegative().default(0),
        carbs: z.number().nonnegative().default(0),
        fats: z.number().nonnegative().default(0),
      },
    },
    async (input) => {
      const [row] = await db
        .insert(meals)
        .values({
          userId,
          timestamp: input.timestamp ? new Date(input.timestamp) : undefined,
          meal: input.meal,
          emoji: input.emoji ?? null,
          foodName: input.foodName,
          calories: input.calories,
          protein: input.protein,
          carbs: input.carbs,
          fats: input.fats,
        })
        .returning()
      return ok(row)
    },
  )

  server.registerTool(
    'delete_meal',
    {
      title: 'Delete a meal',
      description: 'Remove a meal by its UUID. Only succeeds for meals owned by the current user.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const [deleted] = await db
        .delete(meals)
        .where(and(eq(meals.id, id), eq(meals.userId, userId)))
        .returning({ id: meals.id })
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: `No meal found with id=${id}` }],
          isError: true,
        }
      }
      return ok({ ok: true, id: deleted.id })
    },
  )

  server.registerTool(
    'list_goals',
    {
      title: 'List daily goals',
      description:
        'Every daily-goal row for the user (one per date with a configured goal). Pass `date` to filter to a single day.',
      inputSchema: { date: isoDate.optional() },
    },
    async ({ date }) => {
      const conditions = [eq(dailyGoals.userId, userId)]
      if (date) conditions.push(eq(dailyGoals.date, date))
      const rows = await db
        .select()
        .from(dailyGoals)
        .where(and(...conditions))
      return ok(rows)
    },
  )

  server.registerTool(
    'get_goal_for_day',
    {
      title: 'Get goal for a calendar day',
      description:
        'Read the calorie/protein/carbs/fat targets for a specific date. Returns null if no goal is set.',
      inputSchema: { date: isoDate },
    },
    async ({ date }) => {
      const [row] = await db
        .select()
        .from(dailyGoals)
        .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, date)))
        .limit(1)
      return ok(row ?? null)
    },
  )

  server.registerTool(
    'upsert_goal',
    {
      title: 'Set or update daily goal',
      description:
        'Insert or update the nutrition goal for `date`. Keyed on (userId, date) — one goal per calendar day.',
      inputSchema: {
        date: isoDate,
        dayType: z.enum(['training', 'rest']),
        calorieGoal: z.number().positive(),
        proteinGGoal: z.number().nonnegative(),
        carbsGGoal: z.number().nonnegative(),
        fatGGoal: z.number().nonnegative(),
      },
    },
    async (input) => {
      const [row] = await db
        .insert(dailyGoals)
        .values({ userId, ...input })
        .onConflictDoUpdate({
          target: [dailyGoals.userId, dailyGoals.date],
          set: {
            dayType: input.dayType,
            calorieGoal: input.calorieGoal,
            proteinGGoal: input.proteinGGoal,
            carbsGGoal: input.carbsGGoal,
            fatGGoal: input.fatGGoal,
            updatedAt: new Date(),
          },
        })
        .returning()
      return ok(row)
    },
  )

  return server
}
