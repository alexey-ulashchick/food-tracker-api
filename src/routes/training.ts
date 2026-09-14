import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { TrainingSyncResult } from '../../shared/types.ts'
import { db } from '../db/client.ts'
import { dailyGoals, userSettings } from '../db/schema.ts'
import { IntervalsError, fetchPlannedSessions } from '../integrations/intervals.ts'
import { addDays, clientTzOffsetMin, dateRange, todayInOffset } from '../lib/clientDate.ts'
import { isConfigured, missingSetup, readSettings, tuningOf } from '../lib/settings.ts'
import { computeDays } from '../lib/trainingLoad.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

// Pulls the planned sessions from intervals.icu and turns them into automatic
// daily goals. The only writer of `source: 'auto'` rows.

/**
 * How far the window reaches, in days either side of today.
 *
 * Back far enough to cover the six weeks History computes its metrics over
 * (mondayOf(today) − 42 in web/src/lib/calorieMetrics.ts), so the chart and
 * the weekly rollups light up on the first sync rather than filling in a day
 * at a time. It is one request either way and the response is small.
 */
const BACK_DAYS = 42
const FORWARD_DAYS = 21

/**
 * `{ force: true }` bypasses the intervals.icu cache — the refresh button.
 *
 * Hand-parsed rather than validated with zValidator, which 400s a POST that
 * carries no body or no JSON content type. A sync with no options is the
 * normal case and should not need a body at all; chat.ts hand-parses for the
 * same kind of reason.
 */
async function wantsForce(c: { req: { json: () => Promise<unknown> } }): Promise<boolean> {
  try {
    const body = await c.req.json()
    return typeof body === 'object' && body !== null && (body as { force?: unknown }).force === true
  } catch {
    return false
  }
}

export const trainingRoute = new Hono<AuthEnv>()
  .use(auth)
  /**
   * Idempotent: a deterministic computation followed by an upsert. That is
   * what lets the web client drive it from a useQuery with a staleTime rather
   * than from an effect — "at most once every few minutes" is a cache policy,
   * and useQuery is the thing that implements one.
   */
  .post('/sync', async (c) => {
    const userId = c.get('userId')
    const force = await wantsForce(c)

    const settings = await readSettings(userId)
    if (!isConfigured(settings)) {
      const result: TrainingSyncResult = { configured: false, missing: missingSetup(settings) }
      return c.json(result)
    }

    const today = todayInOffset(clientTzOffsetMin(c))
    const from = addDays(today, -BACK_DAYS)
    const to = addDays(today, FORWARD_DAYS)

    let sessions: Awaited<ReturnType<typeof fetchPlannedSessions>>
    try {
      sessions = await fetchPlannedSessions(
        { athleteId: settings.intervalsAthleteId, apiKey: settings.intervalsApiKey },
        from,
        to,
        { force },
      )
    } catch (err) {
      if (err instanceof IntervalsError) {
        // Never the upstream status: a 401 here would make the web API client
        // discard this app's own bearer token over intervals.icu's rejection.
        return c.json({ error: err.message }, 502)
      }
      throw err
    }

    const days = computeDays(
      dateRange(from, to),
      sessions,
      {
        baseCalories: settings.baseCalories,
        proteinG: settings.proteinG,
        fatG: settings.fatG,
      },
      // The user's own coefficients. Changing one and re-syncing is the whole
      // point of the tuning screen, so this must not fall back to the defaults.
      tuningOf(settings),
    )

    const rows = days.map((d) => ({
      userId,
      date: d.date,
      dayType: d.dayType,
      calorieGoal: d.calories,
      proteinGGoal: d.protein,
      carbsGGoal: d.carbs,
      fatGGoal: d.fat,
      source: 'auto' as const,
      breakdown: d.breakdown,
    }))

    // Today and later are kept current; earlier days are only filled in.
    //
    // The split is what stops a plan edit from moving a goal that has already
    // been eaten against. Deleting last Tuesday's workout in intervals.icu
    // should not retroactively lower last Tuesday's target — History would
    // silently re-score a day that is over.
    const ahead = rows.filter((r) => r.date >= today)
    const behind = rows.filter((r) => r.date < today)

    const written =
      ahead.length === 0
        ? []
        : await db
            .insert(dailyGoals)
            .values(ahead)
            .onConflictDoUpdate({
              target: [dailyGoals.userId, dailyGoals.date],
              // `excluded` is the row the insert would have written, spelled
              // the same way src/routes/weights.ts does its batch upsert.
              set: {
                dayType: sql`excluded.day_type`,
                calorieGoal: sql`excluded.calorie_goal`,
                proteinGGoal: sql`excluded.protein_g_goal`,
                carbsGGoal: sql`excluded.carbs_g_goal`,
                fatGGoal: sql`excluded.fat_g_goal`,
                breakdown: sql`excluded.breakdown`,
                updatedAt: new Date(),
              },
              // The whole "manual wins" rule, in one clause. It is a SQL
              // predicate rather than a check in JS so no future writer can
              // forget it: the row simply refuses to be recomputed.
              setWhere: eq(dailyGoals.source, 'auto'),
            })
            .returning({ date: dailyGoals.date })

    if (behind.length > 0) {
      await db
        .insert(dailyGoals)
        .values(behind)
        .onConflictDoNothing({ target: [dailyGoals.userId, dailyGoals.date] })
    }

    const syncedAt = new Date()
    await db
      .update(userSettings)
      .set({ intervalsSyncedAt: syncedAt })
      .where(eq(userSettings.userId, userId))

    const result: TrainingSyncResult = {
      configured: true,
      from,
      to,
      today,
      syncedAt: syncedAt.toISOString(),
      sessions: sessions.length,
      written: written.length,
      skipped: ahead.length - written.length,
    }
    return c.json(result)
  })
