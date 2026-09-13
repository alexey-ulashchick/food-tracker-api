import { createQueryClient } from '@/api/keys'
import { Goals } from '@/screens/Goals'
import type { ServerGoal } from '@shared/types.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The screen's job is to make provenance visible and to open on the day being
// steered, so that is what is pinned: which badge a row carries, which rows
// can be deleted, whether the derivation shown next to a number explains it,
// and where the list starts.
//
// The clock is frozen, because the screen splits its rows on "today" and the
// fixtures name real dates. Without this the suite passes today and fails
// tomorrow, which is worse than failing now.
const TODAY = '2026-09-13'

const listGoals = vi.fn()
const deleteGoal = vi.fn()
const syncTraining = vi.fn()

vi.mock('@/api/endpoints', () => ({
  listGoals: () => listGoals(),
  deleteGoal: (date: string) => deleteGoal(date),
  syncTraining: (force: boolean) => syncTraining(force),
}))

const base: ServerGoal = {
  id: 'a',
  userId: 'u',
  dayType: 'rest',
  date: TODAY,
  calorieGoal: 1450,
  proteinGGoal: 140,
  carbsGGoal: 87,
  fatGGoal: 60,
  source: 'auto',
  breakdown: { base: 1450, strength: 0, rides: [] },
  updatedAt: '2026-09-13T00:00:00.000Z',
}

const goal = (over: Partial<ServerGoal>): ServerGoal => ({ ...base, ...over })

function renderGoals() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Goals />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // shouldAdvanceTime keeps timers ticking, which findBy* and waitFor need.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  // Midday, so no timezone can shift the local date off 13 September.
  vi.setSystemTime(new Date('2026-09-13T12:00:00'))

  listGoals.mockReset()
  deleteGoal.mockReset().mockResolvedValue({ ok: true, id: 'a' })
  syncTraining.mockReset().mockResolvedValue({ configured: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('where the list starts', () => {
  test('opens on today and runs forward, not on the furthest future day', async () => {
    // Newest-first put a date three weeks out at the top and buried today
    // twenty cards below it. Today is the day being steered.
    listGoals.mockResolvedValue([
      goal({ id: 'far', date: '2026-09-15' }),
      goal({ id: 'today', date: TODAY }),
      goal({ id: 'near', date: '2026-09-14' }),
    ])
    renderGoals()

    const dates = await screen.findAllByText(/сент\./)
    expect(dates.map((d) => d.textContent)).toEqual(['13 сент.', '14 сент.', '15 сент.'])
  })

  test('keeps past days behind a button, newest of them first', async () => {
    listGoals.mockResolvedValue([
      goal({ id: 'p2', date: '2026-09-10' }),
      goal({ id: 'today', date: TODAY }),
      goal({ id: 'p1', date: '2026-09-12' }),
    ])
    renderGoals()

    const button = await screen.findByRole('button', { name: 'Прошедшие дни (2)' })
    expect(screen.queryByText('12 сент.')).not.toBeInTheDocument()

    fireEvent.click(button)

    // Awaited on a row that was NOT there before. findAllByText(/сент./) would
    // have resolved on the first render, which already matched today.
    await screen.findByText('12 сент.')
    const dates = screen.getAllByText(/сент\./)
    expect(dates.map((d) => d.textContent)).toEqual(['13 сент.', '12 сент.', '10 сент.'])
    expect(screen.getByText('Прошедшие дни')).toBeInTheDocument()
  })

  test('shows the history outright when there is nothing ahead', async () => {
    // An unsynced plan has no future days, and hiding the only rows there are
    // behind a button would leave the screen looking empty.
    listGoals.mockResolvedValue([
      goal({ id: 'p1', date: '2026-09-12' }),
      goal({ id: 'p2', date: '2026-09-10' }),
    ])
    renderGoals()

    expect(await screen.findByText('12 сент.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Прошедшие дни \(/ })).not.toBeInTheDocument()
  })
})

describe('provenance', () => {
  test('labels where each number came from', async () => {
    listGoals.mockResolvedValue([
      goal({ id: 'm', date: TODAY, source: 'manual', breakdown: null }),
      goal({ id: 'a', date: '2026-09-14' }),
    ])
    renderGoals()

    expect(await screen.findByText('Вручную')).toBeInTheDocument()
    expect(screen.getByText('Расчёт')).toBeInTheDocument()
  })

  test('only a manual goal can be deleted', async () => {
    // A computed row has nothing to delete — the sync would write it straight
    // back — so offering the button would be a lie.
    listGoals.mockResolvedValue([
      goal({ id: 'm', date: TODAY, source: 'manual', breakdown: null }),
      goal({ id: 'a', date: '2026-09-14' }),
    ])
    renderGoals()

    const buttons = await screen.findAllByRole('button', { name: /Удалить цель/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName('Удалить цель на 13 сент.')
  })

  test('deleting asks the server for that exact day', async () => {
    listGoals.mockResolvedValue([goal({ date: TODAY, source: 'manual', breakdown: null })])
    renderGoals()

    const button = await screen.findByRole('button', { name: /Удалить цель/ })
    fireEvent.click(button)

    await waitFor(() => expect(deleteGoal).toHaveBeenCalledWith(TODAY))
  })

  test('a manual goal shows no derivation, because it has none', async () => {
    listGoals.mockResolvedValue([goal({ date: TODAY, source: 'manual', breakdown: null })])
    renderGoals()

    await screen.findByText('Вручную')
    expect(screen.queryByText(/база/)).not.toBeInTheDocument()
  })
})

describe('the derivation', () => {
  test('spells out where a computed goal came from', async () => {
    listGoals.mockResolvedValue([
      goal({
        date: '2026-09-14',
        dayType: 'training',
        calorieGoal: 3210,
        breakdown: {
          base: 1450,
          strength: 250,
          rides: [
            { name: '3x12 SS', kj: 1678, kind: 'threshold', coeff: 0.9, kcal: 1510, minutes: 75 },
          ],
        },
      }),
    ])
    renderGoals()

    expect(await screen.findByText('1450 база + 250 силовая + 1510 вело')).toBeInTheDocument()
    expect(screen.getByText(/3x12 SS · 1678 кДж · SS\/порог · 90%/)).toBeInTheDocument()
  })

  test('says so when a session had no structure to classify', async () => {
    listGoals.mockResolvedValue([
      goal({
        date: '2026-09-14',
        dayType: 'training',
        breakdown: {
          base: 1450,
          strength: 0,
          rides: [
            { name: 'Утренний выезд', kj: 0, kind: 'unknown', coeff: 0.7, kcal: 0, minutes: 120 },
          ],
        },
      }),
    ])
    renderGoals()

    expect(await screen.findByText(/тип не определён/)).toBeInTheDocument()
  })

  test('warns when protein and fat left no room for carbohydrate', async () => {
    listGoals.mockResolvedValue([
      goal({
        date: TODAY,
        carbsGGoal: 0,
        breakdown: { base: 1200, strength: 0, rides: [], carbsClamped: true },
      }),
    ])
    renderGoals()

    expect(await screen.findByText(/углеводы обнулены/)).toBeInTheDocument()
  })
})

describe('the empty and refresh states', () => {
  test('points somewhere useful when there is nothing to show', async () => {
    listGoals.mockResolvedValue([])
    renderGoals()

    expect(await screen.findByText(/Настрой тренировки в Профиле/)).toBeInTheDocument()
  })

  test('the refresh button forces a fetch rather than reusing the cache', async () => {
    listGoals.mockResolvedValue([])
    renderGoals()

    const button = await screen.findByRole('button', { name: 'Обновить план' })
    fireEvent.click(button)

    await waitFor(() => expect(syncTraining).toHaveBeenCalledWith(true))
  })
})
