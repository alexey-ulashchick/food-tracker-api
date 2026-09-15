import {
  INCOMPLETE_RATIO,
  KCAL_PER_KG_FAT,
  ON_TARGET_MAX,
  ON_TARGET_MIN,
} from '@/lib/calorieMetrics'
import { isoWeek } from '@/lib/dates'
import {
  FONT,
  PAGE,
  type Rgb,
  buildPdf,
  fillRect,
  line,
  monoRight,
  monoWidth,
  pieSlice,
  text,
} from '@/lib/pdf'
import type { ServerDaySummary, ServerWeight } from '@shared/types.ts'

// One line per day for the whole observed period: the target, what was eaten,
// the difference, and the macros as they actually were.
//
// English, because the report is a hand-written PDF with no embedded font —
// see the header of lib/pdf.ts for why that trade was made.

// INCOMPLETE_RATIO lives with the other thresholds in lib/calorieMetrics.ts,
// which the History metrics read too — so the two surfaces cannot disagree
// about which days count. Re-exported because this is where the rule applies.
export { INCOMPLETE_RATIO }

/**
 * Every day is exactly one of these, which is what lets a row be read by its
 * colour instead of by a symbol in a legend.
 *
 * `incomplete` is the honest answer for both "no goal to judge against" and
 * "under INCOMPLETE_RATIO of the goal logged" — in neither case is there enough
 * to say whether the day went well.
 */
export type DayStatus = 'onTarget' | 'offTarget' | 'incomplete'

export type ReportDay = {
  date: string
  goal: number | null
  eaten: number
  protein: number
  fat: number
  carbs: number
  status: DayStatus
}

/**
 * How a week reads at a glance.
 *
 * The precedence is deliberate and grey wins. A bar's height is the sum over
 * that week's COMPLETE days, so a week with a gap is drawn shorter than it
 * really was — and that is a fact about the bar, not about the eating. Colouring
 * it red for an overshoot would assert something about a total that is known to
 * be missing days.
 */
export type WeekStatus = 'clean' | 'over' | 'incomplete'

export type WeekBar = {
  /** ISO week, labelled the way the standard numbers it. */
  label: string
  /**
   * Planned minus eaten across the week's complete days.
   *
   * Named for its sign rather than called a "balance": positive is under plan,
   * which for someone in a deficit is the direction progress goes, so the chart
   * reads with good weeks pointing up.
   */
  deficit: number
  /** Complete days the deficit is summed over. Zero when the whole week is a gap. */
  completeDays: number
  /** The deficit per complete day, which is what makes short weeks comparable. */
  perDay: number
  status: WeekStatus
}

/**
 * A calendar month, rolled up.
 *
 * The weekly charts answer "how did the last few weeks go"; this answers "how
 * did the months go", which is the question a four-month report is actually
 * about and which nineteen bars do not.
 */
export type MonthSummary = {
  label: string
  days: number
  onTarget: number
  incomplete: number
  /** Planned minus eaten over the month's complete days. */
  deficit: number
  perDay: number | null
}

export type CalorieReport = {
  from: string
  to: string
  days: ReportDay[]
  onTarget: number
  offTarget: number
  incomplete: number
  /** Averages over the complete days; null when there are none. */
  avgGoal: number | null
  avgEaten: number | null
  avgProtein: number | null
  avgFat: number | null
  avgCarbs: number | null
  /** Planned minus eaten per complete day. Positive is under plan. */
  avgDeficit: number | null
  /** Days the averages are over: on target plus off target. */
  completeDays: number
  /**
   * Planned minus eaten across every complete day, and the fat that implies.
   *
   * A raw kilocalorie total over an arbitrary span says little on its own, which
   * is why it is not presented on its own: printed beside the fat it predicts
   * and the weight actually measured, it becomes the one figure that checks the
   * whole model. Predicted and measured agreeing is the report earning trust;
   * disagreeing is worth knowing too.
   */
  totalDeficit: number
  /** The deficit expressed as body fat, kg. Positive means fat lost. */
  predictedFatKg: number
  weight: { first: number; last: number; delta: number } | null
  weeks: WeekBar[]
  months: MonthSummary[]
}

/** A day nobody logged anything on and set no goal for is not an observation. */
function hasData(day: ServerDaySummary): boolean {
  return day.eaten.calories > 0 || day.goal !== null
}

/**
 * Trims the fetched range to what was actually observed.
 *
 * The range asked for is deliberately generous — the caller cannot know when
 * logging started without asking — so the leading and trailing empty days are
 * dropped here rather than printed as zeroes.
 */
export function trimToObserved(summaries: readonly ServerDaySummary[]): ServerDaySummary[] {
  const first = summaries.findIndex(hasData)
  if (first === -1) return []
  let last = summaries.length - 1
  while (last > first && !hasData(summaries[last]!)) last--
  return summaries.slice(first, last + 1)
}

/**
 * One bar per ISO week the period touches.
 *
 * Keyed by week AND year: an ISO week belongs to whichever year holds its
 * Thursday, so a report spanning New Year would otherwise merge two different
 * week 1s into one bar.
 */
export function weekBars(days: readonly ReportDay[]): WeekBar[] {
  type Bucket = { label: string; goal: number; eaten: number; days: number; incomplete: boolean }
  const byWeek = new Map<string, Bucket>()

  for (const day of days) {
    const { year, week } = isoWeek(day.date)
    const key = `${year}-${String(week).padStart(2, '0')}`
    const bucket = byWeek.get(key) ?? {
      label: `W${week}`,
      goal: 0,
      eaten: 0,
      days: 0,
      incomplete: false,
    }

    // Incomplete days are dropped from both sums before either is taken, so the
    // two sides always cover exactly the same days.
    if (day.status === 'incomplete') {
      bucket.incomplete = true
    } else {
      bucket.goal += day.goal ?? 0
      bucket.eaten += day.eaten
      bucket.days++
    }
    byWeek.set(key, bucket)
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, b]) => {
      const deficit = b.goal - b.eaten
      return {
        label: b.label,
        deficit,
        completeDays: b.days,
        perDay: b.days === 0 ? 0 : deficit / b.days,
        // Grey wins: the height is a sum over the days that counted, so a week
        // with a gap is drawn shorter than it was. That is a fact about the bar,
        // and colouring it by that height would assert something about a total
        // known to be missing days.
        status: b.incomplete ? 'incomplete' : deficit < 0 ? 'over' : 'clean',
      }
    })
}

/** One row per calendar month the period touches, in order. */
export function monthSummaries(days: readonly ReportDay[]): MonthSummary[] {
  const byMonth = new Map<string, MonthSummary & { complete: number }>()

  for (const day of days) {
    const key = day.date.slice(0, 7)
    const row = byMonth.get(key) ?? {
      label: monthLabel(day.date),
      days: 0,
      onTarget: 0,
      incomplete: 0,
      deficit: 0,
      perDay: null,
      complete: 0,
    }

    row.days++
    if (day.status === 'onTarget') row.onTarget++
    if (day.status === 'incomplete') {
      row.incomplete++
    } else {
      // Same rule as the weekly bars: both sides drop the same days.
      row.deficit += (day.goal ?? 0) - day.eaten
      row.complete++
    }
    byMonth.set(key, row)
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, m]) => ({
      label: m.label,
      days: m.days,
      onTarget: m.onTarget,
      incomplete: m.incomplete,
      deficit: m.deficit,
      perDay: m.complete === 0 ? null : m.deficit / m.complete,
    }))
}

export function buildCalorieReport(
  summaries: readonly ServerDaySummary[],
  weights: readonly ServerWeight[],
): CalorieReport {
  const observed = trimToObserved(summaries)

  const days: ReportDay[] = observed.map((d) => {
    const goal = d.goal?.calorieGoal ?? null
    const ratio = goal && goal > 0 ? d.eaten.calories / goal : null
    return {
      date: d.date,
      goal,
      eaten: d.eaten.calories,
      protein: d.eaten.protein,
      fat: d.eaten.fats,
      carbs: d.eaten.carbs,
      // The same band and the same threshold the History metrics use, from the
      // same constants — so a day this refuses to judge is a day History
      // refuses too.
      status:
        ratio === null || ratio < INCOMPLETE_RATIO
          ? 'incomplete'
          : ratio >= ON_TARGET_MIN && ratio <= ON_TARGET_MAX
            ? 'onTarget'
            : 'offTarget',
    }
  })

  // Averages run over the complete days only. Including a day whose log is
  // unfinished does not make the figure better informed, it makes it wrong in
  // the direction that looks like progress.
  const complete = days.filter((d) => d.status !== 'incomplete')
  const mean = (pick: (d: ReportDay) => number) =>
    complete.length === 0 ? null : complete.reduce((s, d) => s + pick(d), 0) / complete.length

  // Planned minus eaten, the same direction and over the same days as the weekly
  // bars, so the two cannot tell different stories.
  const totalDeficit = complete.reduce((sum, d) => sum + ((d.goal ?? 0) - d.eaten), 0)

  const count = (status: DayStatus) => days.filter((d) => d.status === status).length

  const dated = [...weights]
    .filter((w) => (observed.length === 0 ? true : w.date >= days[0]!.date))
    .sort((a, b) => a.date.localeCompare(b.date))
  const firstWeight = dated[0]
  const lastWeight = dated[dated.length - 1]

  return {
    from: days[0]?.date ?? '',
    to: days[days.length - 1]?.date ?? '',
    days,
    onTarget: count('onTarget'),
    offTarget: count('offTarget'),
    incomplete: count('incomplete'),
    avgGoal: mean((d) => d.goal ?? 0),
    avgEaten: mean((d) => d.eaten),
    avgProtein: mean((d) => d.protein),
    avgFat: mean((d) => d.fat),
    avgCarbs: mean((d) => d.carbs),
    avgDeficit: mean((d) => (d.goal ?? 0) - d.eaten),
    completeDays: complete.length,
    totalDeficit,
    predictedFatKg: totalDeficit / KCAL_PER_KG_FAT,
    weeks: weekBars(days),
    months: monthSummaries(days),
    weight:
      firstWeight && lastWeight && firstWeight !== lastWeight
        ? {
            first: firstWeight.kg,
            last: lastWeight.kg,
            delta: lastWeight.kg - firstWeight.kg,
          }
        : null,
  }
}

// ── Layout ─────────────────────────────────────────────────────────────────

const MARGIN = 40
const BODY_SIZE = 8
const LINE = 10.4

/**
 * The row tints, light enough to keep black 8pt text legible on paper.
 *
 * A colour per row rather than a symbol per row: a symbol has to be looked up
 * in a legend once per line, whereas a page of tinted bands is readable at a
 * glance, which was the whole complaint about the first version.
 */
const TINT: Record<DayStatus, Rgb> = {
  onTarget: [0.86, 0.95, 0.86],
  offTarget: [0.99, 0.89, 0.89],
  incomplete: [0.92, 0.92, 0.92],
}

/**
 * The same three hues, saturated.
 *
 * The row tints have to sit under black 8pt text, which puts them within a
 * shade of white — a pie of near-white slices would be unreadable. These are the
 * same colours at full strength, so the association between a slice, a bar and a
 * row still holds.
 */
const SOLID: Record<DayStatus, Rgb> = {
  onTarget: [0.3, 0.69, 0.31],
  offTarget: [0.85, 0.3, 0.28],
  incomplete: [0.62, 0.62, 0.62],
}

const WEEK_COLOUR: Record<WeekStatus, Rgb> = {
  clean: SOLID.onTarget,
  over: SOLID.offTarget,
  incomplete: SOLID.incomplete,
}

/** The band spans the columns, not the whole page — empty tint reads as a bug. */
const BAND_LEFT = MARGIN - 4
const BAND_RIGHT = 440

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** "September 2026" from a YYYY-MM-DD, without going through Date. */
function monthLabel(iso: string): string {
  const [year, month] = iso.split('-')
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`
}
/** Right edges of the numeric columns. Left edge of the date is MARGIN. */
const COL = { goal: 168, eaten: 226, diff: 288, protein: 340, fat: 386, carbs: 432 } as const

const int = (n: number) => String(Math.round(n))
const signed = (n: number) => (n > 0 ? `+${Math.round(n)}` : String(Math.round(n)))
const one = (n: number) => n.toFixed(1)
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

function header(y: number): string {
  return (
    text(MARGIN, y, BODY_SIZE, FONT.monoBold, 'Date') +
    monoRight(COL.goal, y, BODY_SIZE, FONT.monoBold, 'Goal') +
    monoRight(COL.eaten, y, BODY_SIZE, FONT.monoBold, 'Eaten') +
    monoRight(COL.diff, y, BODY_SIZE, FONT.monoBold, 'Diff') +
    monoRight(COL.protein, y, BODY_SIZE, FONT.monoBold, 'P') +
    monoRight(COL.fat, y, BODY_SIZE, FONT.monoBold, 'F') +
    monoRight(COL.carbs, y, BODY_SIZE, FONT.monoBold, 'C') +
    line(MARGIN, y - 3, PAGE.width - MARGIN, y - 3)
  )
}

function row(day: ReportDay, y: number): string {
  const goal = day.goal === null ? '-' : int(day.goal)
  // Blank on an incomplete day. The arithmetic is well defined — a day with a
  // 2400 goal and nothing logged differs by −2400 — but that is exactly the
  // figure the report refuses to believe, and printing it invites reading it as
  // a deficit. What was logged is still shown; only the verdict is withheld.
  const diff = day.goal === null || day.status === 'incomplete' ? '-' : signed(day.eaten - day.goal)

  return (
    // Drawn first, or it would cover the text. Height exactly LINE so
    // consecutive bands tile with no seam between them.
    fillRect(BAND_LEFT, y - 2.8, BAND_RIGHT - BAND_LEFT, LINE, TINT[day.status]) +
    text(MARGIN, y, BODY_SIZE, FONT.mono, day.date) +
    monoRight(COL.goal, y, BODY_SIZE, FONT.mono, goal) +
    monoRight(COL.eaten, y, BODY_SIZE, FONT.mono, int(day.eaten)) +
    monoRight(COL.diff, y, BODY_SIZE, FONT.mono, diff) +
    monoRight(COL.protein, y, BODY_SIZE, FONT.mono, int(day.protein)) +
    monoRight(COL.fat, y, BODY_SIZE, FONT.mono, int(day.fat)) +
    monoRight(COL.carbs, y, BODY_SIZE, FONT.mono, int(day.carbs))
  )
}

// ── The dashboard ──────────────────────────────────────────────────────────
// Page one is a dashboard and nothing else; the day table starts on page two.
// Cramming both onto the first sheet was the whole reason the report read as a
// pile rather than a document.

const CONTENT_RIGHT = PAGE.width - MARGIN
const CONTENT_WIDTH = CONTENT_RIGHT - MARGIN

/** Wide-tracked capitals: a label that reads as a label, not as more prose. */
function sectionLabel(x: number, y: number, s: string): string {
  return text(x, y, 7.5, FONT.sansBold, s.toUpperCase(), 0.9)
}

function rule(y: number, gray = 0.82): string {
  return line(MARGIN, y, CONTENT_RIGHT, y, 0.5, gray)
}

/** label — value, on one baseline, with the value right-aligned to a column. */
function figure(x: number, y: number, label: string, value: string, valueRight: number): string {
  return text(x, y, 8.5, FONT.sans, label) + monoRight(valueRight, y, 8.5, FONT.mono, value)
}

const COLUMN_GAP = 26
const HALF = (CONTENT_WIDTH - COLUMN_GAP) / 2

/**
 * Two columns of figures under the title: how the days went, and what was eaten.
 *
 * Returns the baseline it finished on so the caller keeps control of the rhythm
 * rather than each block guessing where the next one starts.
 */
function dashboard(report: CalorieReport, top: number): { content: string; y: number } {
  const rightColumn = MARGIN + HALF + COLUMN_GAP
  const share = (n: number) =>
    report.days.length === 0 ? '' : `${Math.round((n / report.days.length) * 100)}%`

  let out = sectionLabel(MARGIN, top, 'Days')
  out += sectionLabel(rightColumn, top, 'Intake')

  const rows: Array<[string, string, string, string]> = [
    ['On target', `${report.onTarget}`, 'Average eaten', avg(report.avgEaten)],
    ['Off target', `${report.offTarget}`, 'Average goal', avg(report.avgGoal)],
    ['Incomplete', `${report.incomplete}`, 'Average deficit', avgSigned(report.avgDeficit)],
    [
      'Total',
      `${report.days.length}`,
      'Average macros',
      report.avgProtein === null
        ? '-'
        : `${int(report.avgProtein)} / ${int(report.avgFat ?? 0)} / ${int(report.avgCarbs ?? 0)}`,
    ],
  ]

  let y = top - 15
  for (const [leftLabel, leftValue, rightLabel, rightValue] of rows) {
    // The percentage sits between label and count so the eye reads down two
    // aligned columns instead of hunting along a line.
    const isCount = leftLabel !== 'Total'
    out += text(MARGIN, y, 8.5, FONT.sans, leftLabel)
    out += monoRight(MARGIN + HALF - 46, y, 8.5, FONT.mono, leftValue)
    if (isCount)
      out += monoRight(MARGIN + HALF - 8, y, 8, FONT.mono, share(countOf(report, leftLabel)))
    out += figure(rightColumn, y, rightLabel, rightValue, CONTENT_RIGHT)
    y -= 13
  }

  return { content: out, y }
}

function countOf(report: CalorieReport, label: string): number {
  if (label === 'On target') return report.onTarget
  if (label === 'Off target') return report.offTarget
  return report.incomplete
}

const avg = (v: number | null) => (v === null ? '-' : `${int(v)} kcal`)
const avgSigned = (v: number | null) => (v === null ? '-' : `${signed(v)} kcal`)

/**
 * The outcome block: what the intake predicts, beside what the scale measured.
 *
 * This is the only place a cumulative kilocalorie figure appears, and it appears
 * as an input to a kilogram figure rather than as a number in its own right.
 */
function outcome(report: CalorieReport, top: number): { content: string; y: number } {
  let out = sectionLabel(MARGIN, top, 'Outcome')
  let y = top - 15

  out += figure(
    MARGIN,
    y,
    `Cumulative deficit, ${plural(report.completeDays, 'complete day')}`,
    `${signed(report.totalDeficit)} kcal`,
    MARGIN + HALF + 60,
  )
  y -= 13
  out += figure(
    MARGIN,
    y,
    'Predicted fat change',
    `${kg(-report.predictedFatKg)} kg`,
    MARGIN + HALF + 60,
  )
  y -= 13
  out += figure(
    MARGIN,
    y,
    'Measured weight change',
    report.weight === null ? 'no readings' : `${kg(report.weight.delta)} kg`,
    MARGIN + HALF + 60,
  )
  if (report.weight) {
    out += text(
      MARGIN + HALF + 70,
      y,
      8,
      FONT.mono,
      `${one(report.weight.first)} -> ${one(report.weight.last)}`,
    )
  }

  return { content: out, y: y - 13 }
}

/** Signed to one decimal: a loss is negative, as a scale reads it. */
const kg = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))

// ── The pie ────────────────────────────────────────────────────────────────

/**
 * The three counts as a pie, at the top right of the dashboard.
 *
 * No legend of its own: the counts are in the column to its left and the colours
 * are named in the footer.
 */
function pie(report: CalorieReport, cx: number, cy: number, r: number): string {
  const slices: Array<[DayStatus, number]> = [
    ['onTarget', report.onTarget],
    ['offTarget', report.offTarget],
    ['incomplete', report.incomplete],
  ]
  const total = slices.reduce((sum, [, n]) => sum + n, 0)
  if (total === 0) return ''

  let out = ''
  // From twelve o'clock, clockwise — how a pie is read. PDF's y axis points up,
  // so clockwise means decreasing angle.
  let angle = Math.PI / 2
  for (const [status, n] of slices) {
    if (n === 0) continue
    const sweep = (n / total) * Math.PI * 2
    out += pieSlice(cx, cy, r, angle - sweep, angle, SOLID[status])
    angle -= sweep
  }
  return out
}

// ── The weekly charts ──────────────────────────────────────────────────────

const CHART_HEIGHT = 96
const AXIS_WIDTH = 34
/** Between a chart's caption baseline and the top of its plot. */
const CAPTION_DROP = 13
/** Between one chart's bottom and the next chart's caption. */
const CHART_GAP = 30
const LABEL_DROP = 12

/** 1, 2 or 5 times a power of ten — the steps an axis is allowed to take. */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(v))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (v <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}

/**
 * How tall the axis is, in data units.
 *
 * Not the largest value: one week four times worse than the rest flattens every
 * other bar into a sliver, which is precisely what made the first version
 * unreadable. The axis is sized to the bulk of the data — the 85th percentile of
 * the magnitudes — and anything beyond it is drawn clipped and labelled with its
 * real number. Nothing is hidden; the common range simply gets the height.
 */
function axisLimit(values: readonly number[]): number {
  const magnitudes = values
    .map(Math.abs)
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  if (magnitudes.length === 0) return 1
  const p85 = magnitudes[Math.min(magnitudes.length - 1, Math.floor(0.85 * magnitudes.length))] ?? 1
  return niceCeil(p85)
}

function weekChart(
  weeks: readonly WeekBar[],
  top: number,
  caption: string,
  value: (w: WeekBar) => number,
  withLabels: boolean,
): string {
  if (weeks.length === 0) return ''

  const axis = MARGIN + AXIS_WIDTH
  const values = weeks.map(value)
  const limit = axisLimit(values)

  const hasUp = values.some((v) => v > 0)
  const hasDown = values.some((v) => v < 0)
  // Half the height each way when the data goes both ways; all of it otherwise,
  // rather than spending half the chart on empty paper.
  const upHeight = hasUp ? (hasDown ? CHART_HEIGHT / 2 : CHART_HEIGHT) : 0
  const downHeight = hasDown ? (hasUp ? CHART_HEIGHT / 2 : CHART_HEIGHT) : 0

  const plotBottom = top - CAPTION_DROP - CHART_HEIGHT
  const zeroY = plotBottom + downHeight
  const scale = (v: number) =>
    (Math.min(Math.abs(v), limit) / limit) * (v >= 0 ? upHeight : downHeight)

  let out = sectionLabel(MARGIN, top, caption)

  // Gridlines behind the bars, at the axis limit and at half of it.
  for (const fraction of [1, 0.5]) {
    if (hasUp) {
      const gy = zeroY + upHeight * fraction
      out += line(axis, gy, CONTENT_RIGHT, gy, 0.25, 0.88)
      out += monoRight(axis - 4, gy - 2, 6, FONT.mono, `+${int(limit * fraction)}`)
    }
    if (hasDown) {
      const gy = zeroY - downHeight * fraction
      out += line(axis, gy, CONTENT_RIGHT, gy, 0.25, 0.88)
      out += monoRight(axis - 4, gy - 2, 6, FONT.mono, `-${int(limit * fraction)}`)
    }
  }

  const slot = (CONTENT_RIGHT - axis) / weeks.length
  const barWidth = Math.min(16, slot * 0.62)

  for (const [i, week] of weeks.entries()) {
    const v = values[i] ?? 0
    const x = axis + slot * i + (slot - barWidth) / 2
    const height = scale(v)
    const y = v >= 0 ? zeroY : zeroY - height
    // A week that came out exactly level still gets a mark, or it reads as a
    // week with no data at all.
    out += fillRect(x, y, barWidth, Math.max(height, 0.7), WEEK_COLOUR[week.status])

    if (Math.abs(v) > limit) {
      // The conventional break: two pale notches across the bar near its tip,
      // and the real figure printed beyond it. A silently truncated bar would
      // be a lie told in a chart's own language.
      const tipY = v >= 0 ? y + height : y
      for (const offset of [3, 5.5]) {
        out += fillRect(x, tipY - (v >= 0 ? offset : -offset) - 0.6, barWidth, 1.2, [1, 1, 1])
      }
      const labelY = v >= 0 ? tipY + 2.5 : tipY - 7
      const label = signed(v)
      out += text(x + (barWidth - monoWidth(label, 5.5)) / 2, labelY, 5.5, FONT.mono, label)
    }
  }

  // Drawn last so it stays visible across the bars.
  out += line(axis, zeroY, CONTENT_RIGHT, zeroY, 0.6, 0.35)
  out += monoRight(axis - 4, zeroY - 2, 6, FONT.mono, '0')

  if (withLabels) {
    // Every label if they fit, otherwise every other and so on: overlapping week
    // numbers are worse than fewer of them.
    const every = Math.max(1, Math.ceil((weeks.length * 17) / (CONTENT_RIGHT - axis)))
    for (const [i, week] of weeks.entries()) {
      if (i % every !== 0) continue
      const x = axis + slot * i + (slot - monoWidth(week.label, 6)) / 2
      out += text(x, plotBottom - LABEL_DROP, 6, FONT.mono, week.label)
    }
  }

  return out
}

const CHART_BLOCK = CAPTION_DROP + CHART_HEIGHT

/**
 * Both series, the comparable one first.
 *
 * Per complete day leads because it is the figure weeks can be read against each
 * other by; the weekly total follows for absolute scale.
 */
function weekCharts(weeks: readonly WeekBar[], top: number): string {
  return (
    weekChart(weeks, top, 'Deficit per complete day, kcal', (w) => w.perDay, false) +
    weekChart(weeks, top - CHART_BLOCK - CHART_GAP, 'Weekly deficit, kcal', (w) => w.deficit, true)
  )
}

const CHARTS_HEIGHT = CHART_BLOCK * 2 + CHART_GAP + LABEL_DROP + 6

// ── The monthly table ──────────────────────────────────────────────────────

/** Right edges of the monthly columns. */
const MONTH_COL = { days: 250, onTarget: 316, incomplete: 384, perDay: 462, deficit: CONTENT_RIGHT }

/**
 * A row per calendar month: how many days, how they went, and the deficit.
 *
 * Nineteen weekly bars say how the last few weeks went; a four-month report is
 * usually asked a coarser question than that, and this answers it in five lines.
 */
function monthTable(months: readonly MonthSummary[], top: number): string {
  if (months.length === 0) return ''

  let out = sectionLabel(MARGIN, top, 'By month')
  let y = top - 14

  const heads: Array<[string, number]> = [
    ['Days', MONTH_COL.days],
    ['On target', MONTH_COL.onTarget],
    ['Incomplete', MONTH_COL.incomplete],
    ['Per day', MONTH_COL.perDay],
    ['Deficit', MONTH_COL.deficit],
  ]
  for (const [label, right] of heads) {
    out += monoRight(right, y, 6.5, FONT.monoBold, label)
  }
  out += line(MARGIN, y - 4, CONTENT_RIGHT, y - 4, 0.5, 0.7)
  y -= LINE + 4

  for (const month of months) {
    out += text(MARGIN, y, 8, FONT.sans, month.label)
    out += monoRight(MONTH_COL.days, y, 8, FONT.mono, `${month.days}`)
    out += monoRight(MONTH_COL.onTarget, y, 8, FONT.mono, `${month.onTarget}`)
    out += monoRight(MONTH_COL.incomplete, y, 8, FONT.mono, `${month.incomplete}`)
    out += monoRight(
      MONTH_COL.perDay,
      y,
      8,
      FONT.mono,
      month.perDay === null ? '-' : signed(month.perDay),
    )
    out += monoRight(MONTH_COL.deficit, y, 8, FONT.mono, signed(month.deficit))
    y -= LINE + 2
  }

  return out
}

function monthHeading(label: string, y: number): string {
  return (
    text(MARGIN, y, 9, FONT.sansBold, label) +
    line(MARGIN, y - 3.5, PAGE.width - MARGIN, y - 3.5, 0.5, 0.6)
  )
}

/**
 * The report as PDF bytes.
 *
 * Paginated because one line per day over a year is 365 lines; the summary only
 * appears on the first page and the column header repeats on every one.
 */
export function renderCalorieReportPdf(report: CalorieReport): Uint8Array {
  const bodies: string[] = []
  const bottom = MARGIN + 26
  const topOfPage = PAGE.height - MARGIN - 8

  // ── Page one: the dashboard ─────────────────────────────────────────────
  let page = text(MARGIN, topOfPage, 17, FONT.sansBold, 'Calorie report')
  page += text(
    MARGIN,
    topOfPage - 15,
    9,
    FONT.mono,
    report.from === ''
      ? 'no data'
      : `${report.from} - ${report.to}   ${plural(report.days.length, 'day')}`,
  )
  page += rule(topOfPage - 24)

  const figures = dashboard(report, topOfPage - 42)
  page += figures.content
  // Top right, level with the figures it summarises.
  page += pie(report, CONTENT_RIGHT - 44, topOfPage - 66, 40)

  let y = figures.y - 12
  page += rule(y)

  const result = outcome(report, y - 20)
  page += result.content
  y = result.y - 10
  page += rule(y)

  if (report.weeks.length > 0) {
    page += weekCharts(report.weeks, y - 24)
    y -= 24 + CHARTS_HEIGHT
    page += rule(y)
  }

  page += monthTable(report.months, y - 22)

  bodies.push(page)

  // ── Page two onward: one line per day ───────────────────────────────────
  page = ''
  y = topOfPage
  let month = ''

  page += text(MARGIN, y, 12, FONT.sansBold, 'Daily log')
  y -= 20

  const openTable = () => {
    page += header(y)
    y -= LINE + 3
  }
  openTable()

  for (const day of report.days) {
    const label = monthLabel(day.date)
    // A heading needs its own line plus at least one row under it; breaking
    // between the two would strand it at the foot of a page.
    const needed = label === month ? LINE : LINE * 2 + 10

    if (y - needed < bottom) {
      bodies.push(page)
      page = ''
      y = topOfPage
      // Re-emitted, so a row is never orphaned from the month it belongs to.
      month = ''
      openTable()
    }

    if (label !== month) {
      month = label
      y -= 8
      page += monthHeading(label, y)
      y -= LINE + 3
    }

    page += row(day, y)
    y -= LINE
  }
  bodies.push(page)

  // Footers last: "of N" is not knowable until every page is closed.
  return buildPdf(bodies.map((body, i) => body + footer(i + 1, bodies.length)))
}

const LEGEND: ReadonlyArray<[DayStatus, string]> = [
  ['onTarget', 'on target'],
  ['offTarget', 'off target'],
  [
    'incomplete',
    `incomplete - no goal, or under ${Math.round(INCOMPLETE_RATIO * 100)}% of it logged; left out of the averages`,
  ],
]

function footer(pageNumber: number, total: number): string {
  const y = MARGIN - 12
  let out = line(MARGIN, MARGIN, PAGE.width - MARGIN, MARGIN)

  // Swatches rather than words, so the legend is read in the same way the table
  // is — by colour.
  let x = MARGIN
  for (const [status, caption] of LEGEND) {
    out += fillRect(x, y - 1.5, 8, 7, TINT[status])
    out += text(x + 11, y, 7, FONT.sans, caption)
    x += 11 + caption.length * 3.4 + 10
  }

  return out + text(PAGE.width - MARGIN - 44, y, 7, FONT.sans, `Page ${pageNumber} of ${total}`)
}
