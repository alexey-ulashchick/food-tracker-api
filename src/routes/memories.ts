import { zValidator } from '@hono/zod-validator'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { memories } from '../db/schema.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

// Memories are short free-text sentences the user explicitly asked the app to
// remember. The chat surface (via the LLM) is the primary writer, but iOS
// also surfaces a manual list/edit screen — this route is what backs that.

const contentSchema = z.string().trim().min(1, 'content is required').max(500)

const createSchema = z.object({ content: contentSchema })
const updateSchema = z.object({ content: contentSchema })

const idParam = z.object({
  id: z.string().uuid(),
})

export const memoriesRoute = new Hono<AuthEnv>()
  .use(auth)
  // Newest-updated first — matches what the LLM sees in the system prompt.
  .get('/', async (c) => {
    const userId = c.get('userId')
    const rows = await db
      .select()
      .from(memories)
      .where(eq(memories.userId, userId))
      .orderBy(desc(memories.updatedAt))
    return c.json(rows)
  })
  .post('/', zValidator('json', createSchema), async (c) => {
    const userId = c.get('userId')
    const { content } = c.req.valid('json')
    const [row] = await db.insert(memories).values({ userId, content }).returning()
    return c.json(row!, 201)
  })
  .patch('/:id', zValidator('param', idParam), zValidator('json', updateSchema), async (c) => {
    const userId = c.get('userId')
    const { id } = c.req.valid('param')
    const { content } = c.req.valid('json')

    const [row] = await db
      .update(memories)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(memories.id, id), eq(memories.userId, userId)))
      .returning()

    if (!row) return c.json({ error: 'memory not found' }, 404)
    return c.json(row)
  })
  .delete('/:id', zValidator('param', idParam), async (c) => {
    const userId = c.get('userId')
    const { id } = c.req.valid('param')

    const [row] = await db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, userId)))
      .returning({ id: memories.id })

    if (!row) return c.json({ error: 'memory not found' }, 404)
    return c.json({ ok: true, id: row.id })
  })
