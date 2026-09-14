import { fromIsoDate } from '@/lib/dates'
import type { MealTypeName, ServerMeal } from '@shared/types.ts'

// Copying a logged meal onto today, from the Today screen while viewing an
// earlier day. The interesting part is what time it lands at.

export type NewMeal = {
  timestamp: string
  meal: MealTypeName
  emoji: string | null
  foodName: string
  calories: number
  protein: number
  carbs: number
  fats: number
}

/**
 * The clock time a row displays, in hours and minutes.
 *
 * Mirrors formatLocalTime: the instant is shifted by the offset the meal was
 * eaten at and read back in UTC. Copying has to agree with what the row shows,
 * or the new entry lands at a time the user never saw.
 */
function displayedClock(
  meal: Pick<ServerMeal, 'timestamp' | 'tzOffsetMin'>,
  now: Date,
): { hours: number; minutes: number } | null {
  const parsed = new Date(meal.timestamp)
  if (Number.isNaN(parsed.getTime())) return null

  const effective = meal.tzOffsetMin ?? -now.getTimezoneOffset()
  const shifted = new Date(parsed.getTime() + effective * 60_000)
  return { hours: shifted.getUTCHours(), minutes: shifted.getUTCMinutes() }
}

/**
 * Today, at the same clock time the original row shows.
 *
 * Not `now`: a breakfast copied at nine in the evening should still sit at
 * breakfast time, so the day's log stays in the order it was eaten in. Copying
 * three meals in a row would otherwise pile them all at the current minute,
 * ordered by which one was tapped first.
 *
 * The server stamps tz_offset_min from the request header, so the instant sent
 * here is interpreted in the viewer's current zone — which is why the clock
 * time comes from what the row displays rather than from the original's own
 * zone. What you see is what you get.
 */
export function copyTimestamp(
  meal: Pick<ServerMeal, 'timestamp' | 'tzOffsetMin'>,
  today: string,
  now: Date = new Date(),
): string {
  const clock = displayedClock(meal, now)
  const target = fromIsoDate(today)
  if (clock) target.setHours(clock.hours, clock.minutes, 0, 0)
  return target.toISOString()
}

/** The payload POST /meals wants, taken from an existing row. */
export function mealCopy(meal: ServerMeal, today: string, now: Date = new Date()): NewMeal {
  return {
    timestamp: copyTimestamp(meal, today, now),
    meal: meal.meal,
    emoji: meal.emoji,
    foodName: meal.foodName,
    calories: meal.calories,
    protein: meal.protein,
    carbs: meal.carbs,
    fats: meal.fats,
  }
}
