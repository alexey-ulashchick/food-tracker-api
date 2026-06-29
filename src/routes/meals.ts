import { zValidator } from '@hono/zod-validator'
import { and, desc, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { meals } from '../db/schema.ts'
import {
  type DatedMeal,
  decorateLocalDate,
  fetchMealsByLocalDateRange,
} from '../lib/mealLocalDate.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

const createMealSchema = z.object({
  // ISO 8601 string. Server fills "now" if omitted.
  timestamp: z.string().datetime().optional(),
  meal: z.enum(['Breakfast', 'Lunch', 'Dinner']),
  emoji: z.string().nullish(),
  foodName: z.string().min(1).max(200),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative().default(0),
  carbs: z.number().nonnegative().default(0),
  fats: z.number().nonnegative().default(0),
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

// Either both date params are supplied or neither. The shared
// fetchMealsByLocalDateRange helper takes a closed [dateFrom, dateTo]
// interval; passing only one would be ambiguous.
const listMealsSchema = z
  .object({
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    limit: z.coerce.number().int().positive().max(500).default(100),
  })
  .refine(
    (q) => (q.dateFrom == null && q.dateTo == null) || (q.dateFrom != null && q.dateTo != null),
    { message: 'dateFrom and dateTo must be provided together', path: ['dateFrom'] },
  )
  .refine((q) => q.dateFrom == null || q.dateTo == null || q.dateFrom <= q.dateTo, {
    message: 'dateFrom must be ≤ dateTo',
    path: ['dateFrom'],
  })

const idParamSchema = z.object({
  id: z.string().uuid(),
})

// Reads the X-Client-TZ-Offset header used as a fallback when a meal's
// own tz_offset_min is NULL (legacy rows). Defaults to UTC for callers
// that don't send the header (curl, MCP clients sometimes).
function clientTzOffsetMin(c: Context<AuthEnv>): number {
  const raw = c.req.header('X-Client-TZ-Offset')
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export const mealsRoute = new Hono<AuthEnv>()
  .use(auth)
  // GET /meals
  //   ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  — bucketed by each meal's own
  //                                            local date (mealLocalDate),
  //                                            independent of the caller's
  //                                            TZ. This is the path iOS
  //                                            Today/History and MCP tools
  //                                            should use.
  //   (no date params)                       — newest `limit` meals across
  //                                            all history; intended for
  //                                            debugging/curl, not for
  //                                            day-bucketed UI.
  // Every returned row carries `localDate` (computed via
  // src/lib/mealLocalDate.ts) so clients can group without re-implementing
  // the TZ math.
  .get('/', zValidator('query', listMealsSchema), async (c) => {
    const userId = c.get('userId')
    const { dateFrom, dateTo, limit } = c.req.valid('query')
    const fallbackOffset = clientTzOffsetMin(c)

    let rows: DatedMeal[]
    if (dateFrom && dateTo) {
      rows = await fetchMealsByLocalDateRange(userId, dateFrom, dateTo, fallbackOffset)
    } else {
      const raw = await db
        .select()
        .from(meals)
        .where(eq(meals.userId, userId))
        .orderBy(desc(meals.timestamp))
        .limit(limit)
      rows = raw.map((m) => decorateLocalDate(m, fallbackOffset))
    }

    return c.json(rows)
  })
  .post('/', zValidator('json', createMealSchema), async (c) => {
    const userId = c.get('userId')
    const body = c.req.valid('json')

    const [row] = await db
      .insert(meals)
      .values({
        userId,
        timestamp: body.timestamp ? new Date(body.timestamp) : undefined,
        meal: body.meal,
        emoji: body.emoji ?? null,
        foodName: body.foodName,
        calories: body.calories,
        protein: body.protein,
        carbs: body.carbs,
        fats: body.fats,
      })
      .returning()

    return c.json(decorateLocalDate(row!, clientTzOffsetMin(c)), 201)
  })
  .delete('/:id', zValidator('param', idParamSchema), async (c) => {
    const userId = c.get('userId')
    const { id } = c.req.valid('param')

    const [deleted] = await db
      .delete(meals)
      .where(and(eq(meals.id, id), eq(meals.userId, userId)))
      .returning({ id: meals.id })

    if (!deleted) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true, id: deleted.id })
  })
