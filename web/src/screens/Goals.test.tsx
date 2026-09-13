import { createQueryClient } from '@/api/keys'
import { Goals } from '@/screens/Goals'
import type { ServerGoal } from '@shared/types.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The screen's whole job is to make provenance visible, so that is what is
// pinned: which badge a row carries, which rows can be deleted, and whether
// the derivation shown next to a number actually explains it.

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
  date: '2026-09-11',
  calorieGoal: 1450,
  proteinGGoal: 140,
  carbsGGoal: 87,
  fatGGoal: 60,
  source: 'auto',
  breakdown: { base: 1450, strength: 0, rides: [] },
  updatedAt: '2026-09-11T00:00:00.000Z',
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
  listGoals.mockReset()
  deleteGoal.mockReset().mockResolvedValue({ ok: true, id: 'a' })
  syncTraining.mockReset().mockResolvedValue({ configured: true })
})

describe('the goals screen', () => {
  test('shows newest first, whatever order the API returned', async () => {
    listGoals.mockResolvedValue([
      goal({ id: 'old', date: '2026-09-11' }),
      goal({ id: 'new', date: '2026-09-13' }),
      goal({ id: 'mid', date: '2026-09-12' }),
    ])
    renderGoals()

    const dates = await screen.findAllByText(/сент\./)
    expect(dates.map((d) => d.textContent)).toEqual(['13 сент.', '12 сент.', '11 сент.'])
  })

  test('labels where each number came from', async () => {
    listGoals.mockResolvedValue([
      goal({ id: 'm', date: '2026-09-13', source: 'manual', breakdown: null }),
      goal({ id: 'a', date: '2026-09-12' }),
    ])
    renderGoals()

    expect(await screen.findByText('Вручную')).toBeInTheDocument()
    expect(screen.getByText('Расчёт')).toBeInTheDocument()
  })

  test('only a manual goal can be deleted', async () => {
    // A computed row has nothing to delete — the sync would write it straight
    // back — so offering the button would be a lie.
    listGoals.mockResolvedValue([
      goal({ id: 'm', date: '2026-09-13', source: 'manual', breakdown: null }),
      goal({ id: 'a', date: '2026-09-12' }),
    ])
    renderGoals()

    const buttons = await screen.findAllByRole('button', { name: /Удалить цель/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName('Удалить цель на 13 сент.')
  })

  test('deleting asks the server for that exact day', async () => {
    listGoals.mockResolvedValue([goal({ date: '2026-09-13', source: 'manual', breakdown: null })])
    renderGoals()

    const button = await screen.findByRole('button', { name: /Удалить цель/ })
    button.click()

    await waitFor(() => expect(deleteGoal).toHaveBeenCalledWith('2026-09-13'))
  })

  test('spells out the derivation of a computed goal', async () => {
    listGoals.mockResolvedValue([
      goal({
        date: '2026-09-12',
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
        date: '2026-09-12',
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
        carbsGGoal: 0,
        breakdown: { base: 1200, strength: 0, rides: [], carbsClamped: true },
      }),
    ])
    renderGoals()

    expect(await screen.findByText(/углеводы обнулены/)).toBeInTheDocument()
  })

  test('a manual goal shows no derivation, because it has none', async () => {
    listGoals.mockResolvedValue([goal({ source: 'manual', breakdown: null })])
    renderGoals()

    await screen.findByText('Вручную')
    expect(screen.queryByText(/база/)).not.toBeInTheDocument()
  })

  test('points somewhere useful when there is nothing to show', async () => {
    listGoals.mockResolvedValue([])
    renderGoals()

    expect(await screen.findByText(/Настрой тренировки в Профиле/)).toBeInTheDocument()
  })

  test('the refresh button forces a fetch rather than reusing the cache', async () => {
    listGoals.mockResolvedValue([])
    renderGoals()

    const button = await screen.findByRole('button', { name: 'Обновить план' })
    button.click()

    await waitFor(() => expect(syncTraining).toHaveBeenCalledWith(true))
  })
})
