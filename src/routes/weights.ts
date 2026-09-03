import { zValidator } from '@hono/zod-validator'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { weights } from '../db/schema.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

// Body weight is write-only from outside the app: the user's own sync script
// POSTs batches here, and the web client reads them back for the Weight
// chart. Nothing in the UI creates a row, which is why POST accepts a whole
// array and upserts — a re-run of the script must be a no-op, not a pile of
// duplicates.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const entrySchema = z.object({
  date: isoDate,
  // 500 kg is well past any real reading; it exists to reject unit mix-ups
  // (a script sending pounds would blow straight through it).
  kg: z.number().positive().max(500),
  source: z.string().max(64).nullish(),
})

const createSchema = z.union([entrySchema, z.array(entrySchema).min(1).max(1000)])

const listSchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => q.from == null || q.to == null || q.from <= q.to, {
    message: '`from` must be <= `to`',
    path: ['from'],
  })

const dateParamSchema = z.object({ date: isoDate })

export const weightsRoute = new Hono<AuthEnv>()
  .use(auth)
  // Ascending by date — the chart consumes it in chronological order, and
  // the ISO date column sorts lexicographically the same way.
  .get('/', zValidator('query', listSchema), async (c) => {
    const userId = c.get('userId')
    const { from, to } = c.req.valid('query')

    const conditions = [eq(weights.userId, userId)]
    if (from) conditions.push(gte(weights.date, from))
    if (to) conditions.push(lte(weights.date, to))

    const rows = await db
      .select()
      .from(weights)
      .where(and(...conditions))
      .orderBy(asc(weights.date))

    return c.json(rows)
  })
  // Single entry or a batch. Upserts on (userId, date) so a backfill can be
  // replayed safely. `excluded` is the row Postgres was about to insert.
  .post('/', zValidator('json', createSchema), async (c) => {
    const userId = c.get('userId')
    const body = c.req.valid('json')
    const entries = Array.isArray(body) ? body : [body]

    // A batch carrying the same date twice would make Postgres raise
    // "ON CONFLICT DO UPDATE cannot affect row a second time". Last one wins,
    // which matches the upsert semantics a caller would expect anyway.
    const deduped = [...new Map(entries.map((e) => [e.date, e])).values()]

    const rows = await db
      .insert(weights)
      .values(deduped.map((e) => ({ userId, date: e.date, kg: e.kg, source: e.source ?? null })))
      .onConflictDoUpdate({
        target: [weights.userId, weights.date],
        set: { kg: sql`excluded.kg`, source: sql`excluded.source` },
      })
      .returning()

    return c.json(rows, 201)
  })
  .delete('/:date', zValidator('param', dateParamSchema), async (c) => {
    const userId = c.get('userId')
    const { date } = c.req.valid('param')

    const [row] = await db
      .delete(weights)
      .where(and(eq(weights.userId, userId), eq(weights.date, date)))
      .returning({ id: weights.id })

    if (!row) return c.json({ error: 'weight not found' }, 404)
    return c.json({ ok: true, id: row.id })
  })
