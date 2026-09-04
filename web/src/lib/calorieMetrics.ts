import { addDays, dateRange, diffDays, fromIsoDate, toIsoDate } from './dates'

// Port of loadCalorieMetrics + WeekRollup in HistoryView.swift:493-750.
//
// The missing-data rules are the whole substance of this file and come straight
// from the original spec:
//   * no goal on a day → the mean of explicit goals within ±7 days; if that
//     window is empty too, the day is skipped entirely;
//   * no meals on a day → treated as a perfect match (eaten = goal), so blank
//     days do not drag compliance down;
//   * "on target" is a ratio inside [0.9, 1.1], inclusive at both ends.

export const ON_TARGET_MIN = 0.9
export const ON_TARGET_MAX = 1.1

/** Fat energy density. The UI is Russian, so kg only — the Swift version
 *  branched on Locale and its two screens disagreed as a result. */
export const KCAL_PER_KG_FAT = 7700

export type WeekRollup = {
  onTargetDays: number
  /** Days that had a usable goal; days without one are excluded. */
  totalDays: number
  totalEaten: number
  totalGoal: number
}

export type CalorieMetrics = {
  thisWeek: WeekRollup
  lastSixWeeks: WeekRollup
}

export const EMPTY_ROLLUP: WeekRollup = {
  onTargetDays: 0,
  totalDays: 0,
  totalEaten: 0,
  totalGoal: 0,
}

export function balanceKcal(r: WeekRollup): number {
  return r.totalEaten - r.totalGoal
}

export function compliance(r: WeekRollup): number {
  return r.totalDays > 0 ? r.onTargetDays / r.totalDays : 0
}

/** Monday of the ISO week containing `iso`. */
export function mondayOf(iso: string): string {
  const d = fromIsoDate(iso)
  // getDay(): 0 = Sunday. ISO weeks start on Monday, so Sunday is day 7.
  const dow = d.getDay() === 0 ? 7 : d.getDay()
  return addDays(iso, -(dow - 1))
}

export type DayTotals = {
  /** kcal eaten per localDate; absent means nothing was logged. */
  eatenByDay: Map<string, number>
  /** Explicit calorie goal per date. */
  goalByDay: Map<string, number>
}

/**
 * A day's usable goal: the explicit value, else the mean of explicit goals in
 * the surrounding fortnight, else null (the day is then skipped).
 */
export function effectiveGoal(iso: string, goalByDay: Map<string, number>): number | null {
  const own = goalByDay.get(iso)
  if (own != null) return own

  const nearby: number[] = []
  for (let offset = -7; offset <= 7; offset++) {
    if (offset === 0) continue
    const g = goalByDay.get(addDays(iso, offset))
    if (g != null) nearby.push(g)
  }
  if (nearby.length === 0) return null
  return nearby.reduce((a, b) => a + b, 0) / nearby.length
}

export function rollup(from: string, days: number, totals: DayTotals): WeekRollup {
  let onTargetDays = 0
  let totalDays = 0
  let totalEaten = 0
  let totalGoal = 0

  for (let i = 0; i < days; i++) {
    const iso = addDays(from, i)
    const goal = effectiveGoal(iso, totals.goalByDay)
    if (goal == null || goal <= 0) continue

    // A day with no meals counts as a perfect match rather than a zero.
    const eaten = totals.eatenByDay.get(iso) ?? goal
    totalDays++
    totalEaten += eaten
    totalGoal += goal

    const ratio = eaten / goal
    if (ratio >= ON_TARGET_MIN && ratio <= ON_TARGET_MAX) onTargetDays++
  }

  return { onTargetDays, totalDays, totalEaten, totalGoal }
}

/**
 * This week is Monday → today inclusive; the long window is the 42 days before
 * this Monday, i.e. six complete ISO weeks.
 */
export function calorieMetrics(totals: DayTotals, today: string): CalorieMetrics {
  const monday = mondayOf(today)
  // Inclusive of today. The Swift original had a precedence bug here —
  // `a ?? 0 + 1` parses as `a ?? (0 + 1)` — which quietly counted a day short
  // whenever the component was non-nil.
  const daysThisWeek = Math.max(1, diffDays(monday, today) + 1)

  return {
    thisWeek: rollup(monday, daysThisWeek, totals),
    lastSixWeeks: rollup(addDays(monday, -42), 42, totals),
  }
}

/** The [from, to] span the metrics need, so the caller can fetch it in one go. */
export function metricsRange(today: string): { from: string; to: string } {
  return { from: addDays(mondayOf(today), -42), to: today }
}

// ── Formatting ────────────────────────────────────────────────────────────

/** "+1 240 ккал" / "−830 ккал" / "0 ккал", with a non-breaking group separator. */
export function formatBalance(kcal: number): string {
  const rounded = Math.round(kcal)
  if (rounded === 0) return '0 ккал'
  const sign = rounded > 0 ? '+' : '−'
  return `${sign}${new Intl.NumberFormat('ru-RU').format(Math.abs(rounded))} ккал`
}

export type BalanceTone = 'neutral' | 'surplus' | 'deficit'

/** Within ±50 kcal the user is effectively on the line. */
export function balanceTone(kcal: number): BalanceTone {
  if (Math.abs(kcal) < 50) return 'neutral'
  return kcal > 0 ? 'surplus' : 'deficit'
}

/**
 * Frames a surplus as the fat it corresponds to, plus a weekly rate — "0,72 кг
 * (0,12 кг/нед)". Only meaningful for a surplus, so a deficit returns null.
 */
export function formatFatEquivalent(kcal: number, weeks: number): string | null {
  if (kcal <= 0 || weeks <= 0) return null
  const total = kcal / KCAL_PER_KG_FAT
  const perWeek = total / weeks
  const fmt = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${fmt.format(total)} кг (${fmt.format(perWeek)} кг/нед)`
}

/** Builds the lookup maps the rollups need from raw API rows. */
export function buildDayTotals(
  meals: Array<{ localDate: string; calories: number }>,
  goals: Array<{ date: string; calorieGoal: number }>,
): DayTotals {
  const eatenByDay = new Map<string, number>()
  for (const m of meals) {
    eatenByDay.set(m.localDate, (eatenByDay.get(m.localDate) ?? 0) + m.calories)
  }
  const goalByDay = new Map<string, number>()
  for (const g of goals) goalByDay.set(g.date, g.calorieGoal)
  return { eatenByDay, goalByDay }
}

// ── Chart window ──────────────────────────────────────────────────────────

export type CalorieDay = {
  date: string
  eaten: number | null
  goal: number | null
}

/** 29 days centred on today plus the paging offset — HistoryView.swift:208. */
export const CHART_HALF_WINDOW = 14
export const CHART_PAGE_DAYS = 14

export function chartWindow(today: string, offsetDays: number): { from: string; to: string } {
  const centre = addDays(today, offsetDays)
  return { from: addDays(centre, -CHART_HALF_WINDOW), to: addDays(centre, CHART_HALF_WINDOW) }
}

export function buildCalorieDays(from: string, to: string, totals: DayTotals): CalorieDay[] {
  return dateRange(from, to).map((date) => ({
    date,
    eaten: totals.eatenByDay.get(date) ?? null,
    goal: totals.goalByDay.get(date) ?? null,
  }))
}

/**
 * Y domain for the calorie chart. Deliberately NOT anchored at zero: the
 * interesting variation is around the goal, and a zero floor flattens it.
 */
export function calorieYDomain(days: CalorieDay[]): { lo: number; hi: number } {
  const values = days.flatMap((d) => [d.eaten, d.goal]).filter((v): v is number => v != null)
  if (values.length === 0) return { lo: 0, hi: 100 }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const lo = Math.max(0, min - Math.max(min * 0.15, 200))
  const hi = max + Math.max((max - lo) * 0.1, 100)
  return { lo, hi }
}

/**
 * Extends the last known goal forward over days that have none, so the chart
 * can draw a grey projection past the configured range.
 */
export function goalExtension(days: CalorieDay[]): Array<{ date: string; goal: number }> {
  const lastIndexWithGoal = days.reduce((acc, d, i) => (d.goal != null ? i : acc), -1)
  if (lastIndexWithGoal === -1) return []
  const lastGoal = days[lastIndexWithGoal]!.goal!
  return days.slice(lastIndexWithGoal).map((d) => ({ date: d.date, goal: d.goal ?? lastGoal }))
}

/** Today's key, for callers that only need the default window. */
export function defaultChartWindow(now: Date = new Date()) {
  return chartWindow(toIsoDate(now), 0)
}
