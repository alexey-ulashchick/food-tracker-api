import type { DayTypeName, GoalBreakdown, RideContribution, RideKind } from '../../shared/types.ts'

/**
 * Turns a day's planned training into a calorie target and a macro split.
 *
 * Pure: no database, no HTTP, no clock. src/integrations/intervals.ts
 * normalises the wire shape into PlannedSession and POST /training/sync does
 * the writing, the same division of labour as src/lib/recommend.ts.
 *
 * ── Why the coefficients sit near 1.0 ──────────────────────────────────────
 * A kilojoule of mechanical work at the pedals costs roughly a kilocalorie of
 * metabolic energy: 4.184 kJ/kcal divided by ~24% gross efficiency lands at
 * 1.04. So the percentages below are not a conversion — the conversion is
 * already 1:1 — they are a deliberate discount on it, larger for the sessions
 * where the rule of thumb overshoots most.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Flat bonus per planned strength session, kcal. */
export const STRENGTH_KCAL = 250

/**
 * How much time a block needs before it defines the session.
 *
 * "The dominant step" cannot mean "the longest step": a 3×12 sweet-spot
 * workout spends 40 minutes warming up, recovering and cooling down against
 * 36 minutes of actual work, so longest-wins would file it as Z2. The
 * defining block is instead the hardest one that lasts long enough to matter,
 * which is also what stops a single 2-minute surge inside a three-hour
 * endurance ride from promoting it to VO₂max.
 */
export const DEFINING_BLOCK_SECONDS = 600

/** Upper bound of endurance, as a fraction of FTP. */
export const Z2_MAX_INTENSITY = 0.8
/** Upper bound of sweet spot and threshold. Tempo (0.76–0.90) lands here too:
 *  the user's table has no tempo row, and both of its neighbours are 0.90. */
export const THRESHOLD_MAX_INTENSITY = 1.05

/** Z2 bands, minutes. Closed intervals — the source table left 75–90 min and
 *  anything past 5 h undefined, and a gap in a lookup table is a bug waiting. */
export const Z2_SHORT_MAX_MINUTES = 75
export const Z2_LONG_MIN_MINUTES = 150

export const COEFFICIENTS = {
  /** ≤ 75 min */
  z2Short: 0.7,
  /** 75 min – 2.5 h */
  z2Medium: 0.8,
  /** > 2.5 h */
  z2Long: 0.9,
  threshold: 0.9,
  /** The source range was 90–100%; this is the single value picked from it. */
  vo2max: 0.95,
  /** No structured plan to read, so the most conservative Z2 number. The
   *  breakdown carries kind: 'unknown' so the screen can say as much. */
  unknown: 0.7,
} as const

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

/** Which band an intensity falls in. */
function bandOf(intensity: number): Exclude<RideKind, 'unknown'> {
  if (intensity <= Z2_MAX_INTENSITY) return 'z2'
  if (intensity <= THRESHOLD_MAX_INTENSITY) return 'threshold'
  return 'vo2max'
}

/** Hardest first — the order the defining block is searched in. */
const BANDS_BY_INTENSITY = ['vo2max', 'threshold', 'z2'] as const

/**
 * The session's character, from the time its steps spend in each band.
 *
 * Returns 'unknown' only when there are no steps to read at all.
 */
export function classifyRide(steps: readonly PlannedStep[]): RideKind {
  const seconds = new Map<Exclude<RideKind, 'unknown'>, number>()
  for (const step of steps) {
    if (!(step.seconds > 0)) continue
    const band = bandOf(step.intensity)
    seconds.set(band, (seconds.get(band) ?? 0) + step.seconds)
  }
  if (seconds.size === 0) return 'unknown'

  for (const band of BANDS_BY_INTENSITY) {
    if ((seconds.get(band) ?? 0) >= DEFINING_BLOCK_SECONDS) return band
  }

  // Nothing lasted long enough to be the defining block — a very short
  // session. Fall back to wherever most of it was spent.
  let best: Exclude<RideKind, 'unknown'> = 'z2'
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

/** The multiplier applied to planned kilojoules. */
export function rideCoefficient(kind: RideKind, minutes: number): number {
  switch (kind) {
    case 'z2':
      if (minutes <= Z2_SHORT_MAX_MINUTES) return COEFFICIENTS.z2Short
      if (minutes <= Z2_LONG_MIN_MINUTES) return COEFFICIENTS.z2Medium
      return COEFFICIENTS.z2Long
    case 'threshold':
      return COEFFICIENTS.threshold
    case 'vo2max':
      return COEFFICIENTS.vo2max
    case 'unknown':
      return COEFFICIENTS.unknown
  }
}

/** One ride's contribution, ready to store in the breakdown. */
export function scoreRide(session: PlannedSession): RideContribution {
  const kind = classifyRide(session.steps)
  const coeff = rideCoefficient(kind, session.minutes)
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
): ComputedDay {
  const rides = sessions.filter((s) => s.kind === 'ride').map(scoreRide)
  const strength = sessions.filter((s) => s.kind === 'strength').length * STRENGTH_KCAL

  const calories = Math.round(
    settings.baseCalories + strength + rides.reduce((sum, r) => sum + r.kcal, 0),
  )

  // Protein and fat are fixed; carbohydrate is whatever calories remain.
  const remainder =
    calories - settings.proteinG * KCAL_PER_G_PROTEIN - settings.fatG * KCAL_PER_G_FAT
  const clamped = remainder < 0

  const breakdown: GoalBreakdown = {
    base: settings.baseCalories,
    strength,
    rides,
    ...(clamped ? { carbsClamped: true as const } : {}),
  }

  return {
    date,
    // A planned session makes it a training day even if it scored nothing —
    // the day type describes the plan, not the arithmetic.
    dayType: sessions.some((s) => s.kind === 'ride' || s.kind === 'strength')
      ? 'training'
      : 'rest',
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
): ComputedDay[] {
  const byDate = new Map<string, PlannedSession[]>()
  for (const s of sessions) {
    const bucket = byDate.get(s.date)
    if (bucket) bucket.push(s)
    else byDate.set(s.date, [s])
  }
  return dates.map((date) => computeDay(date, byDate.get(date) ?? [], settings))
}
