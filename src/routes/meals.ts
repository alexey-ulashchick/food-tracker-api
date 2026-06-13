import { zValidator } from '@hono/zod-validator'
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { meals } from '../db/schema.ts'
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

const listMealsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
})

const idParamSchema = z.object({
  id: z.string().uuid(),
})

export const mealsRoute = new Hono<AuthEnv>()
  .use(auth)
  .get('/', zValidator('query', listMealsSchema), async (c) => {
    const userId = c.get('userId')
    const { from, to, limit } = c.req.valid('query')

    const conditions = [eq(meals.userId, userId)]
    if (from) conditions.push(gte(meals.timestamp, new Date(from)))
    if (to) conditions.push(lte(meals.timestamp, new Date(to)))

    const rows = await db
      .select()
      .from(meals)
      .where(and(...conditions))
      .orderBy(desc(meals.timestamp))
      .limit(limit)

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

    return c.json(row!, 201)
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
