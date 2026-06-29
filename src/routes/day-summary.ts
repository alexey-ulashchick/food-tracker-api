// Server-side day classification surface. Returns per-day color + verdict for
// any date range so the iOS app does not need to host its own copy of the
// classifier. The single source of truth lives in src/lib/dietDayClassifier.ts.
//
// Range semantics: [from, to] inclusive on both ends, expressed in the
// caller's local calendar (X-Client-TZ-Offset header). Days without a goal
// row classify as 'gray'.

import { zValidator } from '@hono/zod-validator'
import { and, eq, gte, lte } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { dailyGoals, meals } from '../db/schema.ts'
import { type DietDayVerdict, verdictDietDay } from '../lib/dietDayClassifier.ts'
import { mealLocalDate } from '../lib/mealLocalDate.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const querySchema = z
  .object({
    from: isoDate,
    to: isoDate,
  })
  .refine((q) => q.from <= q.to, {
    message: '`from` must be <= `to`',
    path: ['from'],
  })

type Meal = typeof meals.$inferSelect
type Goal = typeof dailyGoals.$inferSelect

export type DaySummary = {
  date: string
  color: DietDayVerdict['color']
  title: string
  reason: string
  // The raw inputs that produced the verdict, so a client UI can show the
  // dot AND the underlying numbers without a second round-trip.
  eaten: { calories: number; protein: number; carbs: number; fats: number }
  goal: {
    dayType: 'training' | 'rest'
    calorieGoal: number
    proteinGGoal: number
    carbsGGoal: number
    fatGGoal: number
  } | null
}

export const daySummaryRoute = new Hono<AuthEnv>()
  .use(auth)
  .get('/', zValidator('query', querySchema), async (c) => {
    const userId = c.get('userId')
    const { from, to } = c.req.valid('query')
    const tzOffsetMin = clientTzOffsetMin(c)

    // Pull every goal in the range in one query; pull every meal whose UTC
    // timestamp could possibly fall inside the local range (one extra day on
    // each side handles TZ skew). We bucket meals locally afterwards.
    const lookbackStart = new Date(`${from}T00:00:00Z`)
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 1)
    const lookbackEnd = new Date(`${to}T00:00:00Z`)
    lookbackEnd.setUTCDate(lookbackEnd.getUTCDate() + 2)

    const [goalRows, mealRows] = await Promise.all([
      db
        .select()
        .from(dailyGoals)
        .where(
          and(
            eq(dailyGoals.userId, userId),
            gte(dailyGoals.date, from),
            lte(dailyGoals.date, to),
          ),
        ),
      db
        .select()
        .from(meals)
        .where(
          and(
            eq(meals.userId, userId),
            gte(meals.timestamp, lookbackStart),
            lte(meals.timestamp, lookbackEnd),
          ),
        ),
    ])

    const goalsByDate = new Map<string, Goal>()
    for (const g of goalRows) goalsByDate.set(g.date, g)

    const mealsByDate = new Map<string, Meal[]>()
    for (const m of mealRows) {
      const key = mealLocalDate(m, tzOffsetMin)
      const arr = mealsByDate.get(key)
      if (arr) arr.push(m)
      else mealsByDate.set(key, [m])
    }

    const summaries: DaySummary[] = []
    for (const date of dateRange(from, to)) {
      const goal = goalsByDate.get(date)
      const dayMeals = mealsByDate.get(date) ?? []
      const eaten = sumMacros(dayMeals)

      const verdict = verdictDietDay({
        calorieGoal: goal?.calorieGoal ?? null,
        proteinGoal: goal?.proteinGGoal ?? null,
        fatGoal: goal?.fatGGoal ?? null,
        carbGoal: goal?.carbsGGoal ?? null,
        calories: goal ? eaten.calories : null,
        protein: goal ? eaten.protein : null,
        fat: goal ? eaten.fats : null,
        carbs: goal ? eaten.carbs : null,
      })

      summaries.push({
        date,
        color: verdict.color,
        title: verdict.title,
        reason: verdict.reason,
        eaten,
        goal: goal
          ? {
              dayType: goal.dayType,
              calorieGoal: goal.calorieGoal,
              proteinGGoal: goal.proteinGGoal,
              carbsGGoal: goal.carbsGGoal,
              fatGGoal: goal.fatGGoal,
            }
          : null,
      })
    }

    return c.json(summaries)
  })

function clientTzOffsetMin(c: Context<AuthEnv>): number {
  const raw = c.req.header('X-Client-TZ-Offset')
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function sumMacros(rows: Meal[]) {
  return rows.reduce(
    (acc, m) => ({
      calories: acc.calories + m.calories,
      protein: acc.protein + m.protein,
      carbs: acc.carbs + m.carbs,
      fats: acc.fats + m.fats,
    }),
    { calories: 0, protein: 0, carbs: 0, fats: 0 },
  )
}

// Inclusive on both ends, walks calendar dates in ISO YYYY-MM-DD without
// going through Date arithmetic — string math sidesteps DST oddities.
function dateRange(from: string, to: string): string[] {
  const dates: string[] = []
  let cursor = from
  while (cursor <= to) {
    dates.push(cursor)
    cursor = nextDate(cursor)
  }
  return dates
}

function nextDate(d: string): string {
  const t = new Date(`${d}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}
