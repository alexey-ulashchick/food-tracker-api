import {
  DEFAULT_TUNING,
  type GoalTuning,
  bandOf,
  rideCoefficient,
  weekdayAdjustment,
} from '../../shared/goalTuning.ts'
import type { DayTypeName, GoalBreakdown, RideContribution, RideKind } from '../../shared/types.ts'

/**
 * Turns a day's planned training into a calorie target and a macro split.
 *
 * Pure: no database, no HTTP, no clock. src/integrations/intervals.ts
 * normalises the wire shape into PlannedSession and POST /training/sync does
 * the writing, the same division of labour as src/lib/recommend.ts.
 *
 * The numbers themselves are not here. They are a stored, user-editable
 * tuning — see shared/goalTuning.ts, which both this module and the settings
 * screen read. Every entry point takes one and defaults to DEFAULT_TUNING, so
 * a caller that has no user context still computes something sensible.
 */

export { DEFAULT_TUNING, type GoalTuning, rideCoefficient }

// ── Constants ──────────────────────────────────────────────────────────────
// What is left here is arithmetic, not preference: these are the energy
// densities of the macronutrients, and there is nothing to tune about them.

export const KCAL_PER_G_PROTEIN = 4
export const KCAL_PER_G_FAT = 9
export const KCAL_PER_G_CARB = 4

// ── Inputs ─────────────────────────────────────────────────────────────────

export type PlannedStep = {
  seconds: number
  /** Target intensity as a fraction of FTP — 0.92 for 92%. */
  intensity: number
}

export type SessionKind = 'ride' | 'strength' | 'other'

/** One planned event, already lifted out of the intervals.icu wire shape. */
export type PlannedSession = {
  /** YYYY-MM-DD in the athlete's own calendar. */
  date: string
  name: string
  kind: SessionKind
  /** Planned mechanical work, kilojoules. Absent when the plan carries none. */
  kj?: number
  /** Planned moving time. Picks the Z2 band. */
  minutes: number
  /** Flattened planned steps; empty when the event has no structure. */
  steps: PlannedStep[]
  /**
   * Steps that named a wattage no FTP was available to scale.
   *
   * Distinguishes "this event has no plan" from "this event has a plan I could
   * not read", which look identical from `steps` alone and need different
   * fixes.
   */
  unscaledSteps?: number
}

export type TargetSettings = {
  baseCalories: number
  proteinG: number
  fatG: number
}

export type ComputedDay = {
  date: string
  dayType: DayTypeName
  calories: number
  protein: number
  fat: number
  carbs: number
  breakdown: GoalBreakdown
}

// ── Classification ─────────────────────────────────────────────────────────

type Band = 'z2' | 'threshold' | 'vo2max'

/** Hardest first — the order the defining block is searched in. */
const BANDS_BY_INTENSITY: readonly Band[] = ['vo2max', 'threshold', 'z2']

/**
 * The session's character, from the time its steps spend in each band.
 *
 * Returns 'unknown' only when there are no steps to read at all.
 */
export function classifyRide(
  steps: readonly PlannedStep[],
  tuning: GoalTuning = DEFAULT_TUNING,
): RideKind {
  const seconds = new Map<Band, number>()
  for (const step of steps) {
    if (!(step.seconds > 0)) continue
    const band = bandOf(step.intensity, tuning)
    seconds.set(band, (seconds.get(band) ?? 0) + step.seconds)
  }
  if (seconds.size === 0) return 'unknown'

  for (const band of BANDS_BY_INTENSITY) {
    if ((seconds.get(band) ?? 0) >= tuning.definingBlockSeconds) return band
  }

  // Nothing lasted long enough to be the defining block — a very short
  // session. Fall back to wherever most of it was spent.
  let best: Band = 'z2'
  let bestSeconds = -1
  for (const band of BANDS_BY_INTENSITY) {
    const s = seconds.get(band) ?? 0
    if (s > bestSeconds) {
      best = band
      bestSeconds = s
    }
  }
  return best
}

/** One ride's contribution, ready to store in the breakdown. */
export function scoreRide(
  session: PlannedSession,
  tuning: GoalTuning = DEFAULT_TUNING,
): RideContribution {
  // A plan that could not be scaled is not the same as no plan. Only when
  // nothing at all was usable does the reason become the classification —
  // if some steps scaled, they are enough to classify by.
  const kind =
    session.steps.length === 0 && (session.unscaledSteps ?? 0) > 0
      ? 'needs_ftp'
      : classifyRide(session.steps, tuning)
  const coeff = rideCoefficient(kind, session.minutes, tuning)
  const kj = session.kj ?? 0
  return {
    name: session.name,
    kj,
    kind,
    coeff,
    // A ride with no planned work scores zero rather than vanishing: the row
    // stays visible on the goals screen, which is the only way to notice that
    // a session is missing its plan.
    kcal: Math.round(kj * coeff),
    minutes: session.minutes,
  }
}

// ── The day ────────────────────────────────────────────────────────────────

export function computeDay(
  date: string,
  sessions: readonly PlannedSession[],
  settings: TargetSettings,
  tuning: GoalTuning = DEFAULT_TUNING,
): ComputedDay {
  const rides = sessions.filter((s) => s.kind === 'ride').map((s) => scoreRide(s, tuning))
  const strength = sessions.filter((s) => s.kind === 'strength').length * tuning.strengthKcal
  const weekday = weekdayAdjustment(date, tuning)

  // Floored at zero: the adjustment is signed and nothing stops it from being
  // larger than the base. A negative target is not a target.
  const calories = Math.max(
    0,
    Math.round(
      settings.baseCalories + weekday + strength + rides.reduce((sum, r) => sum + r.kcal, 0),
    ),
  )

  // Protein and fat are fixed; carbohydrate is whatever calories remain.
  const remainder =
    calories - settings.proteinG * KCAL_PER_G_PROTEIN - settings.fatG * KCAL_PER_G_FAT
  const clamped = remainder < 0

  const breakdown: GoalBreakdown = {
    base: settings.baseCalories,
    // Absent when it is zero, so a breakdown reads as the sum it describes
    // rather than carrying a term that adds nothing.
    ...(weekday === 0 ? {} : { weekday }),
    strength,
    rides,
    ...(clamped ? { carbsClamped: true as const } : {}),
  }

  return {
    date,
    // A planned session makes it a training day even if it scored nothing —
    // the day type describes the plan, not the arithmetic.
    dayType: sessions.some((s) => s.kind === 'ride' || s.kind === 'strength') ? 'training' : 'rest',
    calories,
    protein: settings.proteinG,
    fat: settings.fatG,
    carbs: clamped ? 0 : Math.round(remainder / KCAL_PER_G_CARB),
    breakdown,
  }
}

/**
 * One ComputedDay per date in `dates`, whether or not anything is planned —
 * a rest day still has a target.
 */
export function computeDays(
  dates: readonly string[],
  sessions: readonly PlannedSession[],
  settings: TargetSettings,
  tuning: GoalTuning = DEFAULT_TUNING,
): ComputedDay[] {
  const byDate = new Map<string, PlannedSession[]>()
  for (const s of sessions) {
    const bucket = byDate.get(s.date)
    if (bucket) bucket.push(s)
    else byDate.set(s.date, [s])
  }
  return dates.map((date) => computeDay(date, byDate.get(date) ?? [], settings, tuning))
}
