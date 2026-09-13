import { eq } from 'drizzle-orm'
import type { ServerSettings } from '../../shared/types.ts'
import { db } from '../db/client.ts'
import { userSettings } from '../db/schema.ts'

// Per-user configuration: the base expenditure and fixed macros that an
// automatic goal is built from, plus the intervals.icu credentials the planned
// session is fetched with.
//
// Lives here rather than in the route module because POST /training/sync needs
// to read the same row, and one reader is better than two spellings of the
// same select.

export type SettingsRow = typeof userSettings.$inferSelect

/** The row, or null if the user has never saved anything. */
export async function readSettings(userId: string): Promise<SettingsRow | null> {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1)
  return row ?? null
}

/**
 * The row, creating an empty one if it does not exist yet.
 *
 * A settings row is a singleton per user carrying no data until something is
 * saved, so materialising it on first read costs one insert ever and keeps the
 * wire type honest — `updatedAt` can stay non-null because there really is a
 * row behind every response.
 */
export async function ensureSettings(userId: string): Promise<SettingsRow> {
  const existing = await readSettings(userId)
  if (existing) return existing

  await db.insert(userSettings).values({ userId }).onConflictDoNothing()
  const created = await readSettings(userId)
  if (!created) throw new Error(`failed to create settings row for ${userId}`)
  return created
}

/**
 * The last four characters of a saved key, or null.
 *
 * Enough to tell two keys apart, not enough to be one. Bare characters, with
 * no leading ellipsis: how it is decorated is the screen's business.
 */
export function keyHint(key: string | null): string | null {
  if (!key) return null
  return key.slice(-4)
}

/** Row → wire: drop the secret, add the hint. */
export function toWire(row: SettingsRow): ServerSettings {
  return {
    userId: row.userId,
    baseCalories: row.baseCalories,
    proteinG: row.proteinG,
    fatG: row.fatG,
    intervalsAthleteId: row.intervalsAthleteId,
    intervalsKeyHint: keyHint(row.intervalsApiKey),
    intervalsSyncedAt: row.intervalsSyncedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Whether an automatic goal can be computed at all. */
export function isConfigured(row: SettingsRow | null): row is SettingsRow & {
  baseCalories: number
  proteinG: number
  fatG: number
  intervalsAthleteId: string
  intervalsApiKey: string
} {
  return (
    row !== null &&
    row.baseCalories !== null &&
    row.proteinG !== null &&
    row.fatG !== null &&
    row.intervalsAthleteId !== null &&
    row.intervalsApiKey !== null
  )
}
