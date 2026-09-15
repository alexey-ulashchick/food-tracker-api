import { ON_TARGET_MAX, ON_TARGET_MIN } from '@/lib/calorieMetrics'
import { FONT, PAGE, buildPdf, line, monoRight, text } from '@/lib/pdf'
import type { ServerDaySummary, ServerWeight } from '@shared/types.ts'

// One line per day for the whole observed period: the target, what was eaten,
// the difference, and the macros as they actually were.
//
// English, because the report is a hand-written PDF with no embedded font —
// see the header of lib/pdf.ts for why that trade was made.

/**
 * Below this share of the goal, a day is not a day of eating very little — it
 * is a day that was not finished being logged.
 *
 * Nobody hits 55% of their target and stops; they forget dinner. Averaging such
 * a day in reports a deficit that never happened, which is the one number a
 * calorie report exists to get right.
 */
export const SUSPECT_RATIO = 0.6

export type ReportDay = {
  date: string
  goal: number | null
  eaten: number
  protein: number
  fat: number
  carbs: number
  /**
   * No goal at all, or so far under it that the log is probably incomplete.
   * Excluded from every average and from the total.
   */
  suspect: boolean
  /** Within the on-target band. False on a suspect day by construction — the
   *  band starts at 0.9 and suspicion starts below 0.6. */
  onTarget: boolean
}

export type CalorieReport = {
  from: string
  to: string
  days: ReportDay[]
  /** Days with a goal and enough logged against it to be trusted. */
  counted: number
  /** The rest: no goal, or under SUSPECT_RATIO of it. */
  suspect: number
  onTarget: number
  /** Averages over the counted days; null when there are none. */
  avgGoal: number | null
  avgEaten: number | null
  avgBalance: number | null
  totalBalance: number
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
    const suspect = ratio === null || ratio < SUSPECT_RATIO
    return {
      date: d.date,
      goal,
      eaten: d.eaten.calories,
      protein: d.eaten.protein,
      fat: d.eaten.fats,
      carbs: d.eaten.carbs,
      suspect,
      // The same band the History metrics use — but not the same treatment of a
      // day with nothing logged. rollup() in lib/calorieMetrics.ts counts such a
      // day as a perfect match ("no meals → eaten = goal", straight from the
      // original spec), so History will report it as on target where this
      // reports it as suspect. Deliberate: a monthly report that scores silence
      // as success is worse than useless, while the History streak is allowed
      // to be forgiving.
      onTarget: !suspect && ratio !== null && ratio >= ON_TARGET_MIN && ratio <= ON_TARGET_MAX,
    }
  })

  // Averages and the total run over the counted days only. Including a day
  // whose log is unfinished does not make the figure more informed, it makes it
  // wrong in a direction that looks like progress.
  const counted = days.filter((d) => !d.suspect)
  const mean = (pick: (d: ReportDay) => number) =>
    counted.length === 0 ? null : counted.reduce((s, d) => s + pick(d), 0) / counted.length

  const totalBalance = counted.reduce((s, d) => s + (d.eaten - (d.goal ?? 0)), 0)

  const dated = [...weights]
    .filter((w) => (observed.length === 0 ? true : w.date >= days[0]!.date))
    .sort((a, b) => a.date.localeCompare(b.date))
  const firstWeight = dated[0]
  const lastWeight = dated[dated.length - 1]

  return {
    from: days[0]?.date ?? '',
    to: days[days.length - 1]?.date ?? '',
    days,
    counted: counted.length,
    suspect: days.filter((d) => d.suspect).length,
    onTarget: days.filter((d) => d.onTarget).length,
    avgGoal: mean((d) => d.goal ?? 0),
    avgEaten: mean((d) => d.eaten),
    avgBalance: mean((d) => d.eaten - (d.goal ?? 0)),
    totalBalance,
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
/** Right edges of the numeric columns. Left edge of the date is MARGIN. */
const COL = { goal: 168, eaten: 226, diff: 288, protein: 340, fat: 386, carbs: 432 } as const

const int = (n: number) => String(Math.round(n))
const signed = (n: number) => (n > 0 ? `+${Math.round(n)}` : String(Math.round(n)))
const one = (n: number) => n.toFixed(1)

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
  const diff = day.goal === null ? '-' : signed(day.eaten - day.goal)
  // One character rather than a word: it is a column of noise either way, and
  // the legend at the foot says what each means. They cannot both apply.
  const mark = day.onTarget ? ' *' : day.suspect ? ' ?' : ''

  return (
    text(MARGIN, y, BODY_SIZE, FONT.mono, `${day.date}${mark}`) +
    monoRight(COL.goal, y, BODY_SIZE, FONT.mono, goal) +
    monoRight(COL.eaten, y, BODY_SIZE, FONT.mono, int(day.eaten)) +
    monoRight(COL.diff, y, BODY_SIZE, FONT.mono, diff) +
    monoRight(COL.protein, y, BODY_SIZE, FONT.mono, int(day.protein)) +
    monoRight(COL.fat, y, BODY_SIZE, FONT.mono, int(day.fat)) +
    monoRight(COL.carbs, y, BODY_SIZE, FONT.mono, int(day.carbs))
  )
}

function summary(report: CalorieReport, y: number): { content: string; y: number } {
  const lines: Array<[string, string]> = [
    ['Period', `${report.from} - ${report.to}   ${report.days.length} days`],
    ['Counted', `${report.counted}`],
    ['Suspect', `${report.suspect}`],
    [
      'On target',
      report.counted === 0
        ? '-'
        : `${report.onTarget} of ${report.counted}   ${Math.round((report.onTarget / report.counted) * 100)}%`,
    ],
    [
      'Average per day',
      report.avgEaten === null
        ? '-'
        : `${int(report.avgEaten)} eaten / ${int(report.avgGoal ?? 0)} goal   ${signed(report.avgBalance ?? 0)}`,
    ],
    [
      'Average macros',
      report.avgProtein === null
        ? '-'
        : `P ${int(report.avgProtein)}   F ${int(report.avgFat ?? 0)}   C ${int(report.avgCarbs ?? 0)}`,
    ],
    ['Total balance', `${signed(report.totalBalance)} kcal`],
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

function footer(pageNumber: number, total: number): string {
  const y = MARGIN - 12
  return (
    line(MARGIN, MARGIN, PAGE.width - MARGIN, MARGIN) +
    text(
      MARGIN,
      y,
      7,
      FONT.sans,
      `* within the on-target band    ? no goal, or under ${Math.round(SUSPECT_RATIO * 100)}% of it - excluded from the averages and the total`,
    ) +
    text(PAGE.width - MARGIN - 70, y, 7, FONT.sans, `Page ${pageNumber} of ${total}`)
  )
}
