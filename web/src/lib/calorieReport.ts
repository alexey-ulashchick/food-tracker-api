import { INCOMPLETE_RATIO, ON_TARGET_MAX, ON_TARGET_MIN } from '@/lib/calorieMetrics'
import { FONT, PAGE, type Rgb, buildPdf, fillRect, line, monoRight, text } from '@/lib/pdf'
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

/** The band spans the columns, not the whole page — empty tint reads as a bug. */
const BAND_LEFT = MARGIN - 4
const BAND_RIGHT = 440
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

  // First page only: title, then the summary, then the table under it.
  page += text(MARGIN, y, 16, FONT.sansBold, 'Calorie report')
  y -= 26
  const block = summary(report, y)
  page += block.content
  y = block.y - 10
  page += header(y)
  y -= LINE + 3

  for (const day of report.days) {
    if (y < bottom) {
      bodies.push(page)
      page = ''
      y = PAGE.height - MARGIN
      page += header(y)
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
