import { mondayOf } from './calorieMetrics'
import { addDays, fromIsoDate, toIsoDate } from './dates'

// Weight aggregation, ported from weeklyAverages + monthlyTrendSlope in
// YouView.swift:252-320.
//
// Units are kg throughout. The Swift version branched on
// Locale.current.measurementSystem, and the result was that YouView showed
// pounds in en_US while WeightView hard-coded kg — the same weight read
// differently on two adjacent screens.

export type WeightPoint = { date: string; kg: number }

export type WeeklyAverage = {
  /** ISO date of the Monday that opens the week. */
  weekStart: string
  avgKg: number
}

/** How many complete weeks the trend line is fitted over. */
export const TREND_WEEKS = 4

/** Buckets samples into ISO weeks (Mon–Sun), ascending by week start. */
export function weeklyAverages(points: WeightPoint[]): WeeklyAverage[] {
  const groups = new Map<string, number[]>()
  for (const p of points) {
    if (!Number.isFinite(p.kg)) continue
    const week = mondayOf(p.date)
    const bucket = groups.get(week)
    if (bucket) bucket.push(p.kg)
    else groups.set(week, [p.kg])
  }

  return [...groups.entries()]
    .map(([weekStart, values]) => ({
      weekStart,
      avgKg: values.reduce((a, b) => a + b, 0) / values.length,
    }))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
}

/**
 * Ordinary-least-squares slope in kg per week over the last complete weeks.
 *
 * Only weeks that ended before this Monday count — the current week is still
 * accumulating and would drag the line. Falls back to however much complete
 * history exists (two points minimum) so the pill appears early rather than
 * waiting a month; null when a line cannot be fitted at all.
 */
export function trendKgPerWeek(
  points: WeightPoint[],
  today: string = toIsoDate(new Date()),
): number | null {
  const weeks = weeklyAverages(points)
  if (weeks.length < 2) return null

  const thisMonday = mondayOf(today)
  const complete = weeks.filter((w) => w.weekStart < thisMonday)
  const recent = complete.slice(-TREND_WEEKS)
  if (recent.length < 2) return null

  // x is the week index, y the average weight.
  const ys = recent.map((w) => w.avgKg)
  const n = ys.length
  const xBar = (n - 1) / 2
  const yBar = ys.reduce((a, b) => a + b, 0) / n

  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = i - xBar
    num += dx * (ys[i]! - yBar)
    den += dx * dx
  }
  if (den <= 0) return null
  return num / den
}

export type TrendTone = 'down' | 'up'

export function trendTone(slope: number): TrendTone {
  return slope < 0 ? 'down' : 'up'
}

/** "−0,25 кг/нед" — losing weight carries its own minus, gaining gets a plus. */
export function formatTrend(slope: number): string {
  const fmt = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const sign = slope < 0 ? '−' : '+'
  return `${sign}${fmt.format(Math.abs(slope))} кг/нед`
}

export function formatKg(kg: number): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(kg)
}

/** Latest reading, or null when there is no history yet. */
export function latestWeight(points: WeightPoint[]): WeightPoint | null {
  let best: WeightPoint | null = null
  for (const p of points) {
    if (!best || p.date > best.date) best = p
  }
  return best
}

/** Change against the most recent reading at least seven days old. */
export function weekDelta(points: WeightPoint[]): number | null {
  const latest = latestWeight(points)
  if (!latest) return null
  const cutoff = addDays(latest.date, -7)

  let earlier: WeightPoint | null = null
  for (const p of points) {
    if (p.date > cutoff) continue
    if (!earlier || p.date > earlier.date) earlier = p
  }
  return earlier ? latest.kg - earlier.kg : null
}

/** Y domain for the weight chart, padded so the line is not flush to the edge. */
export function weightYDomain(weeks: WeeklyAverage[]): { lo: number; hi: number } {
  if (weeks.length === 0) return { lo: 0, hi: 1 }
  const values = weeks.map((w) => w.avgKg)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = Math.max((max - min) * 0.1, 0.5)
  return { lo: min - pad, hi: max + pad }
}

/** Millisecond x position for a week, so the chart can scale time linearly. */
export function weekTime(weekStart: string): number {
  return fromIsoDate(weekStart).getTime()
}
