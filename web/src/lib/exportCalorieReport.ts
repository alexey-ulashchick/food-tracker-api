import { daySummaries, listGoals, listWeights } from '@/api/endpoints'
import { buildCalorieReport, renderCalorieReportPdf } from '@/lib/calorieReport'
import { addDays, todayIso } from '@/lib/dates'

// Exports the whole observed period as a PDF.
//
// Not a screen or a hook: one button's worth of work, and it needs no state
// beyond "in progress", which the caller already tracks through its mutation.

/**
 * How far back to look when the goals do not reach further.
 *
 * There is no endpoint that answers "when did logging start", and /day-summary
 * needs a range up front. A year covers the imported diary; if goals go back
 * further than that, they win. Empty leading days are trimmed off the result,
 * so asking for too much only costs a slightly larger response.
 */
const FALLBACK_LOOKBACK_DAYS = 365

export async function fetchCalorieReport(today: string = todayIso()) {
  const [goals, weights] = await Promise.all([listGoals(), listWeights()])

  const earliestGoal = goals.reduce<string | null>(
    (min, g) => (min === null || g.date < min ? g.date : min),
    null,
  )
  const fallback = addDays(today, -FALLBACK_LOOKBACK_DAYS)
  const from = earliestGoal !== null && earliestGoal < fallback ? earliestGoal : fallback

  const summaries = await daySummaries(from, today)
  return buildCalorieReport(summaries, weights)
}

/**
 * Hands the bytes to the browser as a download.
 *
 * The object URL is revoked on the next task rather than immediately: some
 * browsers have not started reading it by the time click() returns, and
 * revoking too early cancels the download with no error.
 */
export function downloadPdf(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Fetches, renders and downloads. What the button does. */
export async function exportCalorieReport(today: string = todayIso()): Promise<void> {
  const report = await fetchCalorieReport(today)
  const name = report.from === '' ? today : `${report.from}_${report.to}`
  downloadPdf(renderCalorieReportPdf(report), `calories_${name}.pdf`)
}
