import type { ServerDaySummary, ServerGoal, ServerWeight } from '@shared/types.ts'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { downloadPdf, fetchCalorieReport } from './exportCalorieReport'

// Two things: which range gets asked for — there is no endpoint that says when
// logging started, so the choice is a real decision — and that the download
// plumbing does not revoke the URL before the browser has read it.

const listGoals = vi.fn()
const listWeights = vi.fn()
const daySummaries = vi.fn()

vi.mock('@/api/endpoints', () => ({
  listGoals: () => listGoals(),
  listWeights: () => listWeights(),
  daySummaries: (from: string, to: string) => daySummaries(from, to),
}))

const goal = (date: string): ServerGoal => ({
  id: date,
  userId: 'u',
  dayType: 'training',
  date,
  calorieGoal: 2400,
  proteinGGoal: 140,
  carbsGGoal: 300,
  fatGGoal: 60,
  source: 'auto',
  breakdown: null,
  updatedAt: `${date}T00:00:00.000Z`,
})

const summary = (date: string): ServerDaySummary => ({
  date,
  color: 'gray',
  title: '',
  reason: '',
  eaten: { calories: 2000, protein: 150, carbs: 200, fats: 60 },
  goal: {
    dayType: 'training',
    calorieGoal: 2400,
    proteinGGoal: 140,
    carbsGGoal: 300,
    fatGGoal: 60,
  },
})

const requestedFrom = () => daySummaries.mock.calls[0]?.[0] as string

beforeEach(() => {
  listGoals.mockReset().mockResolvedValue([])
  listWeights.mockReset().mockResolvedValue([] as ServerWeight[])
  daySummaries.mockReset().mockResolvedValue([summary('2026-09-14')])
})

describe('the range it asks for', () => {
  test('reaches a year back when the goals do not go further', async () => {
    await fetchCalorieReport('2026-09-14')
    expect(requestedFrom()).toBe('2025-09-14')
    expect(daySummaries.mock.calls[0]?.[1]).toBe('2026-09-14')
  })

  test('reaches further when the goals do', async () => {
    // An imported diary can predate the app by more than a year.
    listGoals.mockResolvedValue([goal('2024-03-01'), goal('2026-01-01')])
    await fetchCalorieReport('2026-09-14')
    expect(requestedFrom()).toBe('2024-03-01')
  })

  test('does not shorten the range just because the goals are recent', async () => {
    // Meals logged before the first goal are still observations.
    listGoals.mockResolvedValue([goal('2026-09-01')])
    await fetchCalorieReport('2026-09-14')
    expect(requestedFrom()).toBe('2025-09-14')
  })

  test('reports the observed period, not the range asked for', async () => {
    daySummaries.mockResolvedValue([summary('2026-09-12'), summary('2026-09-13')])
    const report = await fetchCalorieReport('2026-09-14')
    expect([report.from, report.to]).toEqual(['2026-09-12', '2026-09-13'])
  })
})

describe('downloadPdf', () => {
  const created: string[] = []
  const revoked: string[] = []

  beforeEach(() => {
    created.length = 0
    revoked.length = 0
    // jsdom implements neither.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        const url = `blob:${created.length}`
        created.push(url)
        return url
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('clicks an anchor with the filename and cleans it up', () => {
    const clicked: string[] = []
    const realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      clicked.push((this as HTMLAnchorElement).download)
    }

    downloadPdf(new Uint8Array([1, 2, 3]), 'calories_2026-01-01_2026-09-14.pdf')

    expect(clicked).toEqual(['calories_2026-01-01_2026-09-14.pdf'])
    // Left in the document, the anchor would accumulate one per export.
    expect(document.querySelector('a[download]')).toBeNull()

    HTMLAnchorElement.prototype.click = realClick
  })

  test('revokes the URL only after the current task', async () => {
    // Revoking straight after click() cancels the download in some browsers,
    // which fails silently — no error, no file.
    vi.useFakeTimers()
    const realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = () => {}

    downloadPdf(new Uint8Array([1]), 'x.pdf')
    expect(created).toHaveLength(1)
    expect(revoked).toEqual([])

    vi.advanceTimersByTime(0)
    expect(revoked).toEqual(created)

    HTMLAnchorElement.prototype.click = realClick
  })
})
