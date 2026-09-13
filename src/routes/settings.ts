import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { userSettings } from '../db/schema.ts'
import { ensureSettings, toWire } from '../lib/settings.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

// The base expenditure, the fixed macros, and the intervals.icu credentials.
// POST /training/sync reads all five; nothing else writes them.

/**
 * intervals.icu ids look like `i123456`, but the number alone is what people
 * copy out of the URL. Accept both and normalise, rather than 400ing on the
 * shape the site itself shows you.
 */
const athleteId = z
  .string()
  .trim()
  .regex(/^i?\d{1,20}$/, 'Expected an athlete id like i123456')
  .transform((v) => (v.startsWith('i') ? v : `i${v}`))

const apiKey = z
  .string()
  .trim()
  .min(8, 'Key looks too short')
  .max(256)
  .regex(/^\S+$/, 'Key must not contain whitespace')

/**
 * Partial on purpose, unlike PATCH /goals which demands all six fields: the
 * key is write-only, so requiring a full body would mean re-pasting it to
 * change the protein target.
 *
 * Omitting a field leaves it alone; sending an explicit null clears it.
 * `.strict()` so a misspelled field is a 400 rather than a silent no-op.
 */
const patchSchema = z
  .object({
    // 20000 kcal is well past any real base; it exists to catch a kJ/kcal
    // mix-up, the same way the weights route rejects pounds-as-kilograms.
    baseCalories: z.number().positive().max(20000).nullable(),
    proteinG: z.number().nonnegative().max(1000).nullable(),
    fatG: z.number().nonnegative().max(1000).nullable(),
    intervalsAthleteId: athleteId.nullable(),
    intervalsApiKey: apiKey.nullable(),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Empty patch' })

export const settingsRoute = new Hono<AuthEnv>()
  .use(auth)
  // Never returns intervals_api_key — see toWire(). The row is created on
  // first read so the response shape is the same before and after setup.
  .get('/', async (c) => {
    const row = await ensureSettings(c.get('userId'))
    return c.json(toWire(row))
  })
  .patch('/', zValidator('json', patchSchema), async (c) => {
    const userId = c.get('userId')
    const body = c.req.valid('json')

    await ensureSettings(userId)
    const [row] = await db
      .update(userSettings)
      // Spreading the validated body is safe precisely because the schema is
      // strict: an unknown key cannot reach this object.
      .set({ ...body, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId))
      .returning()

    return c.json(toWire(row!))
  })
