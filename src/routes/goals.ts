import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { dailyGoals } from '../db/schema.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const upsertGoalsSchema = z.object({
  date: isoDate,
  dayType: z.enum(['training', 'rest']),
  calorieGoal: z.number().positive(),
  proteinGGoal: z.number().nonnegative(),
  carbsGGoal: z.number().nonnegative(),
  fatGGoal: z.number().nonnegative(),
})

const listGoalsSchema = z.object({
  date: isoDate.optional(),
})

export const goalsRoute = new Hono<AuthEnv>()
  .use(auth)
  // Without ?date= returns every goal row for the user (one per date that has a
  // configured goal). With ?date= returns the single row for that day, or [].
  .get('/', zValidator('query', listGoalsSchema), async (c) => {
    const userId = c.get('userId')
    const { date } = c.req.valid('query')

    const conditions = [eq(dailyGoals.userId, userId)]
    if (date) conditions.push(eq(dailyGoals.date, date))

    const rows = await db
      .select()
      .from(dailyGoals)
      .where(and(...conditions))

    return c.json(rows)
  })
  // Upsert keyed on (userId, date). dayType is stored as a label for the day
  // (training/rest) but does not partition rows — one goal per calendar day.
  //
  // Always stamps source 'manual' and clears the breakdown: a human asked for
  // this number, so POST /training/sync must stop recomputing the day. Every
  // human-facing writer has to do this — see also set_goal in src/llm/tools.ts
  // and src/mcp/server.ts — because it is what the sync's `setWhere` reads.
  .patch('/', zValidator('json', upsertGoalsSchema), async (c) => {
    const userId = c.get('userId')
    const body = c.req.valid('json')

    const [row] = await db
      .insert(dailyGoals)
      .values({ userId, ...body, source: 'manual', breakdown: null })
      .onConflictDoUpdate({
        target: [dailyGoals.userId, dailyGoals.date],
        set: {
          dayType: body.dayType,
          calorieGoal: body.calorieGoal,
          proteinGGoal: body.proteinGGoal,
          carbsGGoal: body.carbsGGoal,
          fatGGoal: body.fatGGoal,
          source: 'manual',
          breakdown: null,
          updatedAt: new Date(),
        },
      })
      .returning()

    return c.json(row!)
  })
  // Removes a day's goal outright. The goals screen uses it to drop a manual
  // override, after which the next POST /training/sync writes the computed
  // goal back in its place — so this deletes an exception, not the data.
  .delete('/:date', zValidator('param', z.object({ date: isoDate })), async (c) => {
    const userId = c.get('userId')
    const { date } = c.req.valid('param')

    const [row] = await db
      .delete(dailyGoals)
      .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, date)))
      .returning({ id: dailyGoals.id })

    if (!row) return c.json({ error: 'goal not found' }, 404)
    return c.json({ ok: true, id: row.id })
  })
