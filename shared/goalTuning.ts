// The dials that turn planned training into calories, and their defaults.
//
// Lives in shared/ rather than in src/lib/trainingLoad.ts because both sides
// need them: the server computes with them, and the settings screen edits them
// and previews what they would do. One table, one lookup, no second copy to
// drift.
//
// ── Why the coefficients sit near 1.0 ──────────────────────────────────────
// A kilojoule of mechanical work at the pedals costs roughly a kilocalorie of
// metabolic energy: 4.184 kJ/kcal divided by ~24% gross efficiency lands at
// 1.04. So these percentages are not a conversion — the conversion is already
// 1:1 — they are a deliberate discount on it, larger for the sessions where the
// rule of thumb overshoots most.

/** How a planned ride was classified. Mirrors RideKind in types.ts. */
type Kind = 'z2' | 'threshold' | 'vo2max' | 'unknown' | 'needs_ftp'

export type GoalTuning = {
  /** Flat bonus per planned strength session, kcal. */
  strengthKcal: number

  /** Multipliers applied to planned kilojoules. */
  z2Short: number
  z2Medium: number
  z2Long: number
  threshold: number
  vo2max: number
  /** Used when a ride could not be classified at all. */
  unknown: number

  /** Z2 band edges, minutes. Short is ≤ the first, long is > the second. */
  z2ShortMaxMinutes: number
  z2LongMinMinutes: number

  /** Zone edges as a fraction of FTP. */
  z2MaxIntensity: number
  thresholdMaxIntensity: number

  /**
   * How long a block must last to define the session.
   *
   * The reason this is a dial and not a constant: "the dominant step" cannot
   * mean "the longest step". A 3×12 sweet-spot workout spends more time warming
   * up, recovering and cooling down than working, so longest-wins files it as
   * Z2. The defining block is the hardest one that lasts long enough to matter,
   * and how long that is depends on how you write your intervals.
   */
  definingBlockSeconds: number

  /**
   * A flat kcal adjustment per weekday, added to the base.
   *
   * Seven named fields rather than an array, so they inherit the bounds, the
   * merge, the overrides-only storage and the form from the same table every
   * other dial uses. Signed: a lighter Monday is negative.
   */
  monKcal: number
  tueKcal: number
  wedKcal: number
  thuKcal: number
  friKcal: number
  satKcal: number
  sunKcal: number
}

/** Monday first, which is how the week reads and how the form lists it. */
export const WEEKDAY_FIELDS = [
  { key: 'monKcal', label: 'Пн' },
  { key: 'tueKcal', label: 'Вт' },
  { key: 'wedKcal', label: 'Ср' },
  { key: 'thuKcal', label: 'Чт' },
  { key: 'friKcal', label: 'Пт' },
  { key: 'satKcal', label: 'Сб' },
  { key: 'sunKcal', label: 'Вс' },
] as const satisfies ReadonlyArray<{ key: keyof GoalTuning; label: string }>

export const DEFAULT_TUNING: GoalTuning = {
  strengthKcal: 250,
  z2Short: 0.7,
  z2Medium: 0.8,
  z2Long: 0.9,
  threshold: 0.9,
  /** The source range was 90–100%; this is the single value picked from it. */
  vo2max: 0.95,
  unknown: 0.7,
  z2ShortMaxMinutes: 75,
  z2LongMinMinutes: 150,
  z2MaxIntensity: 0.8,
  /** Tempo (0.76–0.90) lands in threshold; both of its neighbours are 0.90. */
  thresholdMaxIntensity: 1.05,
  definingBlockSeconds: 600,
  // Zero, so the feature costs nothing until someone uses it — and so a
  // weekday left alone is absent from the stored overrides.
  monKcal: 0,
  tueKcal: 0,
  wedKcal: 0,
  thuKcal: 0,
  friKcal: 0,
  satKcal: 0,
  sunKcal: 0,
}

// ── Editing ────────────────────────────────────────────────────────────────

/** How a field is written down, which decides how it is shown and bounded. */
export type TuningUnit = 'kcal' | 'ratio' | 'minutes' | 'seconds'

export type TuningField = {
  key: keyof GoalTuning
  label: string
  unit: TuningUnit
  /** Bounds in stored units, enforced by the server and shown by the client. */
  min: number
  max: number
  hint?: string
}

/** A multiplier below 10% or above 200% of the work done is not a tuning. */
const RATIO_MIN = 0.1
const RATIO_MAX = 2

/** A weekday nudge, either way. Past this it is not a nudge but a second base. */
const WEEKDAY_LIMIT = 2000

/**
 * Every dial, grouped as the settings screen shows them.
 *
 * The single source for both the form and the server's validation — a field
 * added here is editable and bounded without touching either side.
 */
export const TUNING_GROUPS: ReadonlyArray<{
  /** Stable handle for a group the form treats specially. */
  id: string
  title: string
  /** Explains the group where one line per field would only repeat itself. */
  hint?: string
  fields: readonly TuningField[]
}> = [
  {
    id: 'coefficients',
    title: 'Коэффициенты',
    fields: [
      { key: 'z2Short', label: 'Z2 короткий', unit: 'ratio', min: RATIO_MIN, max: RATIO_MAX },
      { key: 'z2Medium', label: 'Z2 средний', unit: 'ratio', min: RATIO_MIN, max: RATIO_MAX },
      { key: 'z2Long', label: 'Z2 длинный', unit: 'ratio', min: RATIO_MIN, max: RATIO_MAX },
      { key: 'threshold', label: 'SS / порог', unit: 'ratio', min: RATIO_MIN, max: RATIO_MAX },
      { key: 'vo2max', label: 'VO₂max', unit: 'ratio', min: RATIO_MIN, max: RATIO_MAX },
      {
        key: 'unknown',
        label: 'Не определено',
        unit: 'ratio',
        min: RATIO_MIN,
        max: RATIO_MAX,
        hint: 'Когда план прочитать не удалось',
      },
    ],
  },
  {
    id: 'strength',
    title: 'Силовая',
    fields: [
      {
        key: 'strengthKcal',
        label: 'За тренировку',
        unit: 'kcal',
        min: 0,
        max: 2000,
        hint: 'Фиксированная надбавка, килоджоули тут не при чём',
      },
    ],
  },
  {
    id: 'z2bands',
    title: 'Полосы Z2',
    fields: [
      { key: 'z2ShortMaxMinutes', label: 'Короткий до', unit: 'minutes', min: 10, max: 600 },
      { key: 'z2LongMinMinutes', label: 'Длинный от', unit: 'minutes', min: 20, max: 1200 },
    ],
  },
  {
    id: 'zones',
    title: 'Границы зон',
    fields: [
      { key: 'z2MaxIntensity', label: 'Z2 до', unit: 'ratio', min: 0.3, max: 1 },
      { key: 'thresholdMaxIntensity', label: 'Порог до', unit: 'ratio', min: 0.5, max: 2 },
    ],
  },
  {
    id: 'weekday',
    title: 'Поправка по дням недели',
    // What these are actually for: the base expenditure is one number, but the
    // walking around it is not the same on a Monday as on a Saturday.
    hint: 'Поправка на обычное число шагов в этот день недели. Прибавляется к базе.',
    fields: WEEKDAY_FIELDS.map((d) => ({
      key: d.key,
      label: d.label,
      unit: 'kcal' as const,
      min: -WEEKDAY_LIMIT,
      max: WEEKDAY_LIMIT,
    })),
  },
  {
    id: 'defining',
    title: 'Определяющий блок',
    fields: [
      {
        key: 'definingBlockSeconds',
        label: 'Минимум',
        unit: 'seconds',
        min: 60,
        max: 3600,
        hint: 'Самая интенсивная зона, набравшая столько времени, задаёт тип',
      },
    ],
  },
]

export const TUNING_FIELDS: readonly TuningField[] = TUNING_GROUPS.flatMap((g) => g.fields)

const FIELD_BY_KEY = new Map(TUNING_FIELDS.map((f) => [f.key, f]))

/**
 * Stored value → a complete tuning.
 *
 * Overlays whatever numeric fields are present onto the defaults, so a row
 * written before a dial existed keeps working and a dial removed later is
 * ignored rather than throwing. Out-of-range values fall back to the default
 * instead of poisoning the arithmetic.
 */
export function mergeTuning(stored: unknown): GoalTuning {
  const merged = { ...DEFAULT_TUNING }
  if (!stored || typeof stored !== 'object') return merged

  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const field = FIELD_BY_KEY.get(key as keyof GoalTuning)
    if (!field) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value < field.min || value > field.max) continue
    merged[field.key] = value
  }

  return orderedOrDefault(merged)
}

/**
 * Two pairs of dials have to stay in order, or a band closes over nothing.
 *
 * With the short edge above the long edge, no duration is "medium"; with the Z2
 * edge above the threshold edge, no intensity is threshold. Both are reported
 * as errors on the way in, so this only guards a row that was already stored
 * or hand-edited.
 */
function orderedOrDefault(t: GoalTuning): GoalTuning {
  const fixed = { ...t }
  if (fixed.z2ShortMaxMinutes > fixed.z2LongMinMinutes) {
    fixed.z2ShortMaxMinutes = DEFAULT_TUNING.z2ShortMaxMinutes
    fixed.z2LongMinMinutes = DEFAULT_TUNING.z2LongMinMinutes
  }
  if (fixed.z2MaxIntensity > fixed.thresholdMaxIntensity) {
    fixed.z2MaxIntensity = DEFAULT_TUNING.z2MaxIntensity
    fixed.thresholdMaxIntensity = DEFAULT_TUNING.thresholdMaxIntensity
  }
  return fixed
}

/** Whether a tuning is orderable, and what to say if not. */
export function tuningOrderError(t: Partial<GoalTuning>): string | null {
  const full = { ...DEFAULT_TUNING, ...t }
  if (full.z2ShortMaxMinutes > full.z2LongMinMinutes) {
    return '«Короткий до» не может быть больше «Длинный от»'
  }
  if (full.z2MaxIntensity > full.thresholdMaxIntensity) {
    return '«Z2 до» не может быть больше «Порог до»'
  }
  return null
}

/** Only the fields that differ from the defaults — what gets stored. */
export function tuningOverrides(t: GoalTuning): Partial<GoalTuning> {
  const out: Partial<GoalTuning> = {}
  for (const field of TUNING_FIELDS) {
    if (t[field.key] !== DEFAULT_TUNING[field.key]) out[field.key] = t[field.key]
  }
  return out
}

// ── Lookups ────────────────────────────────────────────────────────────────

/** Which zone an intensity falls in, per the configured edges. */
export function bandOf(
  intensity: number,
  tuning: GoalTuning = DEFAULT_TUNING,
): 'z2' | 'threshold' | 'vo2max' {
  if (intensity <= tuning.z2MaxIntensity) return 'z2'
  if (intensity <= tuning.thresholdMaxIntensity) return 'threshold'
  return 'vo2max'
}

/**
 * The weekday adjustment for a calendar date, in kcal.
 *
 * Anchored to UTC midnight on purpose: the only question is which weekday that
 * calendar date is, and reading it in the viewer's zone could answer with the
 * neighbouring day for half of every evening.
 */
export function weekdayAdjustment(date: string, tuning: GoalTuning = DEFAULT_TUNING): number {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return 0
  // getUTCDay is Sunday-first; WEEKDAY_FIELDS is Monday-first.
  const index = (parsed.getUTCDay() + 6) % 7
  return tuning[WEEKDAY_FIELDS[index]!.key]
}

/** The label the goals screen puts next to that adjustment. */
export function weekdayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return ''
  return WEEKDAY_FIELDS[(parsed.getUTCDay() + 6) % 7]!.label
}

/** The multiplier applied to a ride's planned kilojoules. */
export function rideCoefficient(
  kind: Kind,
  minutes: number,
  tuning: GoalTuning = DEFAULT_TUNING,
): number {
  switch (kind) {
    case 'z2':
      if (minutes <= tuning.z2ShortMaxMinutes) return tuning.z2Short
      if (minutes <= tuning.z2LongMinMinutes) return tuning.z2Medium
      return tuning.z2Long
    case 'threshold':
      return tuning.threshold
    case 'vo2max':
      return tuning.vo2max
    case 'unknown':
    case 'needs_ftp':
      return tuning.unknown
  }
}
