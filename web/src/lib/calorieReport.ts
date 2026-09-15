import { INCOMPLETE_RATIO, ON_TARGET_MAX, ON_TARGET_MIN } from '@/lib/calorieMetrics'
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
  weight: { first: number; last: number; delta: number } | null
  weeks: WeekBar[]
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
    weeks: weekBars(days),
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

function summary(report: CalorieReport, y: number): { content: string; y: number } {
  const complete = report.onTarget + report.offTarget
  const share = (n: number) =>
    report.days.length === 0 ? '' : `   ${Math.round((n / report.days.length) * 100)}%`

  const lines: Array<[string, string]> = [
    ['Period', `${report.from} - ${report.to}`],
    ['Total days', `${report.days.length}`],
    ['On target', `${report.onTarget}${share(report.onTarget)}`],
    ['Off target', `${report.offTarget}${share(report.offTarget)}`],
    ['Incomplete data', `${report.incomplete}${share(report.incomplete)}`],
    [
      'Average calories',
      report.avgEaten === null
        ? '-'
        : // The basis is spelled out: an average that silently skipped a third
          // of the period would be the most misleading number on the page.
          `${int(report.avgEaten)} eaten / ${int(report.avgGoal ?? 0)} goal, over ${plural(complete, 'complete day')}`,
    ],
    [
      'Average macros',
      report.avgProtein === null
        ? '-'
        : `P ${int(report.avgProtein)}   F ${int(report.avgFat ?? 0)}   C ${int(report.avgCarbs ?? 0)}`,
    ],
  ]

  if (report.weight) {
    lines.push([
      'Weight',
      `${one(report.weight.first)} -> ${one(report.weight.last)} kg   ${report.weight.delta > 0 ? '+' : ''}${one(report.weight.delta)}`,
    ])
  }

  let content = ''
  let cursor = y
  for (const [key, value] of lines) {
    content += text(MARGIN, cursor, 9, FONT.sans, key)
    content += text(MARGIN + 110, cursor, 9, FONT.mono, value)
    cursor -= 12.5
  }
  return { content, y: cursor }
}

/**
 * The three counts as a pie, beside the summary that lists them.
 *
 * No legend of its own: the slices use the row colours, which the footer already
 * names, and the numbers are in the summary a few centimetres to the left.
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

/** Two charts stacked; the second carries the week labels for both. */
const CHART_HEIGHT = 52
/** Room for the axis figures, so none of them sits in the page margin. */
const AXIS_WIDTH = 26
const CHART_CAPTION_GAP = 12
const CHART_LABEL_GAP = 11
const CHARTS_TOTAL_HEIGHT = (CHART_HEIGHT + CHART_CAPTION_GAP) * 2 + CHART_LABEL_GAP

/**
 * A bar per ISO week: planned minus eaten, over that week's complete days.
 *
 * The zero line is placed to fit the data rather than centred, because a period
 * spent in deficit has almost nothing below it and a centred axis would spend
 * half the chart on empty paper.
 */
function weekChart(
  weeks: readonly WeekBar[],
  top: number,
  caption: string,
  value: (w: WeekBar) => number,
  withLabels: boolean,
): string {
  // A gutter for the axis figures rather than letting them hang into the page
  // margin, where a printer may well cut them off.
  const axis = MARGIN + AXIS_WIDTH
  const left = MARGIN
  const right = PAGE.width - MARGIN
  if (weeks.length === 0) return ''

  const values = weeks.map(value)
  const up = Math.max(0, ...values)
  const down = Math.max(0, ...values.map((v) => -v))
  const span = up + down
  const plotBottom = top - CHART_HEIGHT
  const zeroY = span === 0 ? plotBottom : plotBottom + (down / span) * CHART_HEIGHT

  const slot = (right - axis) / weeks.length
  const barWidth = Math.min(18, slot * 0.7)

  let out = text(left, top + 4, 7, FONT.sans, caption)

  for (const [i, week] of weeks.entries()) {
    const v = values[i] ?? 0
    const x = axis + slot * i + (slot - barWidth) / 2
    const height = span === 0 ? 0 : (Math.abs(v) / span) * CHART_HEIGHT
    const y = v >= 0 ? zeroY : zeroY - height
    // A week that came out exactly level still gets a mark, or it reads as a
    // week with no data.
    out += fillRect(x, y, barWidth, Math.max(height, 0.8), WEEK_COLOUR[week.status])
  }

  // After the bars, so it stays visible across them.
  out += line(axis, zeroY, right, zeroY, 0.5, 0.55)
  const tick = axis - 3
  out += monoRight(tick, zeroY - 2, 6, FONT.mono, '0')
  // The extremes, so a bar's height means something without a full axis.
  if (up > 0) out += monoRight(tick, top - 4, 6, FONT.mono, `+${Math.round(up)}`)
  if (down > 0) out += monoRight(tick, plotBottom, 6, FONT.mono, `-${Math.round(down)}`)

  if (withLabels) {
    // Every label if they fit, otherwise every other and so on: overlapping week
    // numbers are worse than fewer of them.
    const every = Math.max(1, Math.ceil((weeks.length * 16) / (right - left)))
    for (const [i, week] of weeks.entries()) {
      if (i % every !== 0) continue
      const x = axis + slot * i + (slot - monoWidth(week.label, 6)) / 2
      out += text(x, plotBottom - CHART_LABEL_GAP + 3, 6, FONT.mono, week.label)
    }
  }

  return out
}

/** Both series: the week's total, then the same divided by its complete days. */
function weekCharts(weeks: readonly WeekBar[], top: number): string {
  return (
    weekChart(
      weeks,
      top,
      'Weekly deficit, kcal: planned minus eaten, complete days only',
      (w) => w.deficit,
      false,
    ) +
    weekChart(
      weeks,
      top - CHART_HEIGHT - CHART_CAPTION_GAP,
      'Per complete day, kcal',
      (w) => w.perDay,
      true,
    )
  )
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
  const bottom = MARGIN + 24

  let page = ''
  let y = PAGE.height - MARGIN
  // Re-emitted at the top of every page, so a row is never orphaned from the
  // month it belongs to.
  let month = ''

  page += text(MARGIN, y, 16, FONT.sansBold, 'Calorie report')
  y -= 26

  const block = summary(report, y)
  page += block.content
  // Beside the summary, not below it: the two say the same thing and reading
  // them together is the point.
  page += pie(report, PAGE.width - MARGIN - 52, y - 34, 46)
  y = block.y - 14

  if (report.weeks.length > 0) {
    page += weekCharts(report.weeks, y)
    y -= CHARTS_TOTAL_HEIGHT + 10
  }

  const openTable = () => {
    page += header(y)
    y -= LINE + 3
  }
  openTable()

  for (const day of report.days) {
    const label = monthLabel(day.date)
    // A heading needs its own line plus at least one row under it; breaking
    // between the two would strand it at the foot of a page.
    const needed = label === month ? LINE : LINE * 2 + 8

    if (y - needed < bottom) {
      bodies.push(page)
      page = ''
      y = PAGE.height - MARGIN
      month = ''
      openTable()
    }

    if (label !== month) {
      month = label
      y -= 6
      page += monthHeading(label, y)
      y -= LINE + 2
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
