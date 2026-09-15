import { createQueryClient } from '@/api/keys'
import { History } from '@/screens/History'
import type { ServerDaySummary, ServerGoal, ServerMeal } from '@shared/types.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Only the metrics row, and only the part this change turned into a hazard.
//
// Dropping "a blank day is a perfect day" shrinks the denominator, so a week
// with two logged days out of seven reports "2 / 2 · 100%". That is a different
// lie in the same direction, and the only thing standing between it and the
// screen is the count of days the rollup refused. If that stops rendering, the
// screen goes back to flattering — silently.

// A Friday, so "Пн — сегодня" spans five days and there is room for some of
// them to be missing. On a Tuesday the week is two days long and the case this
// file exists for cannot arise.
const TODAY = '2026-09-18'

const listGoals = vi.fn()
const listMeals = vi.fn()
const daySummaries = vi.fn()

vi.mock('@/api/endpoints', () => ({
  listGoals: () => listGoals(),
  listMeals: (from: string, to: string) => listMeals(from, to),
  daySummaries: (from: string, to: string) => daySummaries(from, to),
}))

const goal = (date: string, calorieGoal = 2000): ServerGoal => ({
  id: date,
  userId: 'u',
  dayType: 'training',
  date,
  calorieGoal,
  proteinGGoal: 140,
  carbsGGoal: 300,
  fatGGoal: 60,
  source: 'auto',
  breakdown: null,
  updatedAt: `${date}T00:00:00.000Z`,
})

const meal = (date: string, calories: number): ServerMeal => ({
  id: `${date}-m`,
  userId: 'u',
  timestamp: `${date}T12:00:00.000Z`,
  tzOffsetMin: 0,
  meal: 'Lunch',
  emoji: null,
  foodName: 'x',
  calories,
  protein: 0,
  carbs: 0,
  fats: 0,
  updatedAt: `${date}T12:00:00.000Z`,
  localDate: date,
})

function renderHistory() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <History />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`))
  listGoals.mockReset().mockResolvedValue([])
  listMeals.mockReset().mockResolvedValue([])
  daySummaries.mockReset().mockResolvedValue([] as ServerDaySummary[])
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * The metrics row with this title.
 *
 * There are two — this week and the last six — and they can show the same
 * figures, so every assertion has to name which one it means.
 */
const row = (title: string): HTMLElement => {
  const element = screen.getByText(title).closest('div')?.parentElement
  if (!element) throw new Error(`no metrics row titled ${title}`)
  return element
}

describe('the weekly metrics', () => {
  const WEEK = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']

  test('says how many days it left out', async () => {
    // Goals all week; only Monday and Tuesday logged.
    listGoals.mockResolvedValue(WEEK.map((d) => goal(d)))
    listMeals.mockResolvedValue([meal('2026-09-14', 2000), meal('2026-09-15', 2000)])

    renderHistory()

    // Two counted, both on target — and the row must not stop there.
    await screen.findByText('2 / 2 в цели')
    expect(row('Эта неделя').textContent).toContain('2 / 2 в цели')
    expect(row('Эта неделя').textContent).toContain('100% попаданий')
    // Wednesday to Friday have goals and nothing logged.
    expect(row('Эта неделя').textContent).toContain('3 без данных')
  })

  test('a fully logged week says nothing about missing days', async () => {
    listGoals.mockResolvedValue(WEEK.map((d) => goal(d)))
    listMeals.mockResolvedValue(WEEK.map((d) => meal(d, 2000)))

    renderHistory()

    await screen.findByText('5 / 5 в цели')
    // The six-week row has no data at all, so it does report missing days;
    // this is about the current week's row only.
    expect(row('Эта неделя').textContent).not.toContain('без данных')
  })

  test('a week with nothing logged reports no hits, not a perfect score', async () => {
    // The old behaviour scored exactly this 5 / 5 at 100%.
    listGoals.mockResolvedValue(WEEK.map((d) => goal(d)))
    listMeals.mockResolvedValue([])

    renderHistory()

    await screen.findAllByText('0 / 0 в цели')
    const thisWeek = row('Эта неделя').textContent ?? ''
    expect(thisWeek).toContain('0 / 0 в цели')
    expect(thisWeek).toContain('0% попаданий')
    expect(thisWeek).toContain('5 без данных')
  })
})
