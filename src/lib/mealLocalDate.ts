// Shared meal-by-date helpers. Single source of truth for "what calendar day
// does this meal belong to?" — every read path (HTTP GET /meals, MCP
// list_meals + get_meals_for_day, LLM tool get_meals_for_day, /day-summary
// and /chat's today-snapshot blocks) routes through here so we never drift
// between callers.
//
// Rule: a meal's day is computed from its OWN tz_offset_min, not the
// caller's. When the column is null (shouldn't happen after migration, but
// kept as a defence), we fall back to the caller's offset.

import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { meals } from '../db/schema.ts'

type Meal = typeof meals.$inferSelect

// Decorated row returned by fetchMealsByLocalDateRange — same shape as a
// raw Meal plus the computed local-date string. Callers that need to bucket
// by day just key on `.localDate` without re-running the math.
export type DatedMeal = Meal & { localDate: string }

// Pixels of UTC padding around the requested date range, in hours. Real
// max TZ offset on Earth is +14 (Kiribati). 15h is comfortable.
const TZ_PAD_HOURS = 15

export function mealLocalDate(
  m: { timestamp: Date; tzOffsetMin: number | null },
  fallbackOffsetMin: number,
): string {
  const offset = m.tzOffsetMin ?? fallbackOffsetMin
  return new Date(m.timestamp.getTime() + offset * 60_000).toISOString().slice(0, 10)
}

// Returns every meal whose `mealLocalDate(meal, fallback)` falls inside
// [dateFrom, dateTo] (inclusive). Internally fetches a generous UTC window
// (±TZ_PAD_HOURS) so the SQL still rides the (user_id, timestamp) index;
// the precise per-meal filter runs in JS on a small post-query set.
//
// Ordering: most-recent-first to match the existing /meals semantics.
// Callers that want chronological (e.g. LLM get_meals_for_day) reverse it.
export async function fetchMealsByLocalDateRange(
  userId: string,
  dateFrom: string,
  dateTo: string,
  fallbackOffsetMin: number,
): Promise<DatedMeal[]> {
  const lo = new Date(`${dateFrom}T00:00:00Z`)
  lo.setUTCHours(lo.getUTCHours() - TZ_PAD_HOURS)
  const hi = new Date(`${dateTo}T23:59:59.999Z`)
  hi.setUTCHours(hi.getUTCHours() + TZ_PAD_HOURS)

  const rows = await db
    .select()
    .from(meals)
    .where(
      and(eq(meals.userId, userId), gte(meals.timestamp, lo), lte(meals.timestamp, hi)),
    )
    .orderBy(desc(meals.timestamp))

  const result: DatedMeal[] = []
  for (const m of rows) {
    const localDate = mealLocalDate(m, fallbackOffsetMin)
    if (localDate >= dateFrom && localDate <= dateTo) {
      result.push({ ...m, localDate })
    }
  }
  return result
}

// Convenience: decorate an already-fetched meal with its localDate without
// hitting the DB again. Used by /chat to project meals it already pulled
// for the LLM context block.
export function decorateLocalDate(m: Meal, fallbackOffsetMin: number): DatedMeal {
  return { ...m, localDate: mealLocalDate(m, fallbackOffsetMin) }
}
