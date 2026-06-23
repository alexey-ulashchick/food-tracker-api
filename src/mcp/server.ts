import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, desc, eq, gte, lt, lte } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { dailyGoals, meals, memories } from '../db/schema.ts'

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .describe('Calendar date in YYYY-MM-DD format')

const mealEnum = z.enum(['Breakfast', 'Lunch', 'Dinner', 'Snack'])
const dayTypeEnum = z.enum(['training', 'rest'])

// One-day [start, end) UTC window for a YYYY-MM-DD literal interpreted in
// the caller's TZ offset (minutes east of UTC).
function dayBounds(date: string, offsetMin: number): { start: Date; end: Date } {
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime()
  const start = new Date(utcMidnight - offsetMin * 60_000)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function notFound(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

// Builds a fresh McpServer scoped to a single authenticated user. We re-build
// per request so userId is captured by closure and tool handlers don't have to
// thread auth context through.
//
// Tool naming mirrors src/llm/tools.ts so external clients and the in-app LLM
// share the same vocabulary (add_meal / update_meal / delete_meal / set_goal).
// list_meals / list_goals are MCP-only conveniences for clients that need to
// browse without a fixed date.
export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: 'food-tracker',
    version: '0.1.0',
  })

  const userTag = userId.slice(0, 8)

  // Wraps a tool handler so every MCP call is one line in stdout — name +
  // input preview going in, ok/err + ms coming out. Mirrors the [chat]
  // logging shape so a single grep ("[mcp] tool-call") finds everything.
  const logged =
    <T>(name: string, fn: (input: T) => Promise<ReturnType<typeof ok>>) =>
    async (input: T) => {
      const json = JSON.stringify(input ?? {})
      const preview = json.length > 400 ? `${json.slice(0, 400)}…` : json
      console.log(`[mcp] tool-call user=${userTag} name=${name} input=${preview}`)
      const startedAt = performance.now()
      try {
        const result = await fn(input)
        const ms = Math.round(performance.now() - startedAt)
        const status = (result as { isError?: boolean }).isError ? 'err' : 'ok'
        console.log(`[mcp] tool-${status} user=${userTag} name=${name} took=${ms}ms`)
        return result
      } catch (err) {
        const ms = Math.round(performance.now() - startedAt)
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[mcp] tool-throw user=${userTag} name=${name} took=${ms}ms err=${msg}`)
        throw err
      }
    }

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
    logged('list_meals', async ({ from, to, limit }) => {
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
    }),
  )

  server.registerTool(
    'get_meals_for_day',
    {
      title: 'Get meals for a calendar day',
      description:
        "Every meal logged on a specific calendar date (interpreted in the caller's TZ), ordered by time. Each row includes its id — use that id with update_meal or delete_meal.",
      inputSchema: {
        date: isoDate,
        tzOffsetMin: z
          .number()
          .int()
          .min(-720)
          .max(840)
          .describe(
            'TZ offset in minutes east of UTC defining the calendar day boundaries (matches iOS TimeZone.current.secondsFromGMT()/60).',
          ),
      },
    },
    logged('get_meals_for_day', async ({ date, tzOffsetMin }) => {
      const { start, end } = dayBounds(date, tzOffsetMin)
      const rows = await db
        .select()
        .from(meals)
        .where(and(eq(meals.userId, userId), gte(meals.timestamp, start), lt(meals.timestamp, end)))
        .orderBy(meals.timestamp)
      return ok(rows)
    }),
  )

  server.registerTool(
    'add_meal',
    {
      title: 'Log a meal',
      description:
        "Insert a new meal entry. `timestamp` defaults to now if omitted. `tzOffsetMin` is the user's local TZ offset (minutes east of UTC) at the place the meal was eaten — needed so dashboards can bucket the meal by its own local date even after the user travels.",
      inputSchema: {
        timestamp: z
          .string()
          .datetime()
          .optional()
          .describe('ISO 8601 when the food was eaten. Server fills "now" if omitted.'),
        tzOffsetMin: z
          .number()
          .int()
          .min(-720)
          .max(840)
          .describe(
            'Local TZ offset in minutes east of UTC where the meal was eaten. Matches iOS TimeZone.current.secondsFromGMT()/60 and JS -getTimezoneOffset().',
          ),
        meal: mealEnum,
        emoji: z.string().nullish().describe('Single food emoji.'),
        foodName: z.string().min(1).max(200),
        calories: z.number().nonnegative(),
        protein: z.number().nonnegative().default(0),
        carbs: z.number().nonnegative().default(0),
        fats: z.number().nonnegative().default(0),
      },
    },
    logged('add_meal', async (input) => {
      const [row] = await db
        .insert(meals)
        .values({
          userId,
          timestamp: input.timestamp ? new Date(input.timestamp) : undefined,
          tzOffsetMin: input.tzOffsetMin,
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
    }),
  )

  server.registerTool(
    'update_meal',
    {
      title: 'Edit a meal',
      description:
        'Update an existing meal in place. Pass only the fields that change; omitted fields stay as they are. Use get_meals_for_day to look up the id when needed.',
      inputSchema: {
        id: z.string().uuid(),
        timestamp: z.string().datetime().optional(),
        tzOffsetMin: z
          .number()
          .int()
          .min(-720)
          .max(840)
          .nullable()
          .optional()
          .describe('Local TZ offset (minutes east of UTC). Pass null to clear the stored offset.'),
        meal: mealEnum.optional(),
        emoji: z.string().nullish(),
        foodName: z.string().min(1).max(200).optional(),
        calories: z.number().nonnegative().optional(),
        protein: z.number().nonnegative().optional(),
        carbs: z.number().nonnegative().optional(),
        fats: z.number().nonnegative().optional(),
      },
    },
    logged('update_meal', async (input) => {
      const patch: Partial<typeof meals.$inferInsert> = {}
      if (input.timestamp !== undefined) patch.timestamp = new Date(input.timestamp)
      if (input.meal !== undefined) patch.meal = input.meal
      if ('emoji' in input) patch.emoji = input.emoji ?? null
      if (input.foodName !== undefined) patch.foodName = input.foodName
      if (input.calories !== undefined) patch.calories = input.calories
      if (input.protein !== undefined) patch.protein = input.protein
      if (input.carbs !== undefined) patch.carbs = input.carbs
      if (input.fats !== undefined) patch.fats = input.fats
      if ('tzOffsetMin' in input && input.tzOffsetMin !== undefined) {
        patch.tzOffsetMin = input.tzOffsetMin
      }

      if (Object.keys(patch).length === 0) {
        return notFound('update_meal requires at least one field besides id')
      }

      const [row] = await db
        .update(meals)
        .set(patch)
        .where(and(eq(meals.id, input.id), eq(meals.userId, userId)))
        .returning()
      if (!row) return notFound(`No meal found with id=${input.id}`)
      return ok(row)
    }),
  )

  server.registerTool(
    'delete_meal',
    {
      title: 'Delete a meal',
      description: 'Remove a meal by its UUID. Only succeeds for meals owned by the current user.',
      inputSchema: { id: z.string().uuid() },
    },
    logged('delete_meal', async ({ id }) => {
      const [deleted] = await db
        .delete(meals)
        .where(and(eq(meals.id, id), eq(meals.userId, userId)))
        .returning({ id: meals.id })
      if (!deleted) return notFound(`No meal found with id=${id}`)
      return ok({ ok: true, id: deleted.id })
    }),
  )

  server.registerTool(
    'list_goals',
    {
      title: 'List daily goals',
      description:
        'Every daily-goal row for the user (one per date with a configured goal). Use get_goal_for_day to read a single date.',
      inputSchema: {},
    },
    logged('list_goals', async () => {
      const rows = await db.select().from(dailyGoals).where(eq(dailyGoals.userId, userId))
      return ok(rows)
    }),
  )

  server.registerTool(
    'get_goal_for_day',
    {
      title: 'Get goal for a calendar day',
      description:
        'Read the calorie/protein/carbs/fat targets for a specific date. Returns null if no goal is set.',
      inputSchema: { date: isoDate },
    },
    logged('get_goal_for_day', async ({ date }) => {
      const [row] = await db
        .select()
        .from(dailyGoals)
        .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, date)))
        .limit(1)
      return ok(row ?? null)
    }),
  )

  server.registerTool(
    'set_goal',
    {
      title: 'Set or update daily goal',
      description:
        'Insert or replace the nutrition goal for `date`. Keyed on (userId, date) — one goal per calendar day.',
      inputSchema: {
        date: isoDate,
        dayType: dayTypeEnum,
        calorieGoal: z.number().positive(),
        proteinGGoal: z.number().nonnegative(),
        carbsGGoal: z.number().nonnegative(),
        fatGGoal: z.number().nonnegative(),
      },
    },
    logged('set_goal', async (input) => {
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
    }),
  )

  server.registerTool(
    'list_memories',
    {
      title: 'List memories',
      description:
        'Long-lived facts/preferences/recipes the user asked the assistant to remember. Newest-updated first. Each row has an id you can pass to update_memory or delete_memory.',
      inputSchema: {},
    },
    logged('list_memories', async () => {
      const rows = await db
        .select()
        .from(memories)
        .where(eq(memories.userId, userId))
        .orderBy(desc(memories.updatedAt))
      return ok(rows)
    }),
  )

  server.registerTool(
    'add_memory',
    {
      title: 'Save a memory',
      description:
        'Save a single short sentence the user asked to remember (preference, allergy, recipe, recurring dish, routine).',
      inputSchema: {
        content: z.string().min(1).max(500),
      },
    },
    logged('add_memory', async ({ content }) => {
      const [row] = await db.insert(memories).values({ userId, content }).returning()
      return ok(row)
    }),
  )

  server.registerTool(
    'update_memory',
    {
      title: 'Update a memory',
      description:
        'Replace the content of an existing memory in place. The id comes from list_memories.',
      inputSchema: {
        id: z.string().uuid(),
        content: z.string().min(1).max(500),
      },
    },
    logged('update_memory', async ({ id, content }) => {
      const [row] = await db
        .update(memories)
        .set({ content, updatedAt: new Date() })
        .where(and(eq(memories.id, id), eq(memories.userId, userId)))
        .returning()
      if (!row) return notFound(`No memory found with id=${id}`)
      return ok(row)
    }),
  )

  server.registerTool(
    'delete_memory',
    {
      title: 'Delete a memory',
      description: 'Remove a memory by its UUID.',
      inputSchema: { id: z.string().uuid() },
    },
    logged('delete_memory', async ({ id }) => {
      const [row] = await db
        .delete(memories)
        .where(and(eq(memories.id, id), eq(memories.userId, userId)))
        .returning({ id: memories.id })
      if (!row) return notFound(`No memory found with id=${id}`)
      return ok({ ok: true, id: row.id })
    }),
  )

  return server
}
