import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  DEFAULT_TUNING,
  type GoalTuning,
  TUNING_FIELDS,
  tuningOrderError,
  tuningOverrides,
} from '../../shared/goalTuning.ts'
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
 * Every dial, bounded by the same numbers the form shows.
 *
 * Built from TUNING_FIELDS rather than spelled out, so a dial added there is
 * validated here without a second edit — the failure mode being a field the
 * server silently drops while the screen claims it saved.
 */
const tuningSchema = z
  .object(
    Object.fromEntries(
      TUNING_FIELDS.map((f) => [f.key, z.number().min(f.min).max(f.max).optional()]),
    ) as Record<keyof GoalTuning, z.ZodOptional<z.ZodNumber>>,
  )
  .strict()
  .refine((t) => tuningOrderError(t) === null, {
    message: 'Границы полос перевёрнуты',
  })

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
    // A whole tuning in, only the differences from the defaults stored. Null
    // resets every dial, which is what the screen's "Сбросить" sends.
    goalTuning: tuningSchema.nullable(),
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

    // Stored as overrides: a dial left at its default is absent, so adding a
    // dial later arrives at its default for everyone rather than needing a
    // backfill. An empty object and null both mean "all defaults".
    const goalTuning =
      body.goalTuning === undefined
        ? undefined
        : body.goalTuning === null
          ? null
          : nullIfEmpty(tuningOverrides({ ...DEFAULT_TUNING, ...body.goalTuning }))

    const [row] = await db
      .update(userSettings)
      // Spreading the validated body is safe precisely because the schema is
      // strict: an unknown key cannot reach this object.
      .set({ ...body, ...(goalTuning === undefined ? {} : { goalTuning }), updatedAt: new Date() })
      .where(eq(userSettings.userId, userId))
      .returning()

    return c.json(toWire(row!))
  })

function nullIfEmpty(overrides: Partial<GoalTuning>): Partial<GoalTuning> | null {
  return Object.keys(overrides).length === 0 ? null : overrides
}
