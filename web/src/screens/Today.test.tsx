import { createQueryClient } from '@/api/keys'
import { Today } from '@/screens/Today'
import { useUi } from '@/store/ui'
import type { ServerMeal } from '@shared/types.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Only the copy-to-today action. The rest of the screen is a port of the Swift
// layout and is covered by the e2e pass; what is pinned here is the rule that
// the action appears on other days but not on today, and that it takes two
// deliberate taps.

const TODAY = '2026-09-14'
const LAST_WEEK = '2026-09-07'

const listMeals = vi.fn()
const createMeal = vi.fn()

vi.mock('@/api/endpoints', () => ({
  listMeals: (from: string, to: string) => listMeals(from, to),
  createMeal: (meal: unknown) => createMeal(meal),
  getGoal: () => Promise.resolve(null),
  daySummaries: () => Promise.resolve([]),
}))

const MEAL: ServerMeal = {
  id: 'm1',
  userId: 'u',
  timestamp: '2026-09-07T05:30:00.000Z',
  tzOffsetMin: 180,
  meal: 'Breakfast',
  emoji: '🥞',
  foodName: 'Овсянка с бананом',
  calories: 420,
  protein: 14,
  carbs: 70,
  fats: 8,
  updatedAt: '2026-09-07T05:30:00.000Z',
  localDate: LAST_WEEK,
}

function renderToday(viewingDate: string) {
  useUi.setState({ viewingDate })
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Today />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const copyButton = () => screen.findByRole('button', { name: /Добавить .* в сегодня/ })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`))
  listMeals.mockReset().mockResolvedValue([MEAL])
  createMeal.mockReset().mockResolvedValue({ ...MEAL, id: 'm2', localDate: TODAY })
})

afterEach(() => {
  vi.useRealTimers()
  useUi.setState({ viewingDate: TODAY })
})

describe('copying a meal onto today', () => {
  test('is not offered while looking at today', async () => {
    // "Add to today" from inside today says nothing, and the log is what this
    // screen is mostly for.
    renderToday(TODAY)
    await screen.findByText('Овсянка с бананом')
    expect(screen.queryByRole('button', { name: /в сегодня/ })).not.toBeInTheDocument()
  })

  test('names the food, because a screen reader hears it once per row', async () => {
    renderToday(LAST_WEEK)
    expect(await copyButton()).toHaveAccessibleName('Добавить «Овсянка с бананом» в сегодня')
  })

  test('the first tap only arms it', async () => {
    renderToday(LAST_WEEK)
    fireEvent.click(await copyButton())

    expect(await screen.findByRole('button', { name: 'В сегодня?' })).toBeInTheDocument()
    expect(createMeal).not.toHaveBeenCalled()
  })

  test('the second tap logs it on today, at the time the row showed', async () => {
    renderToday(LAST_WEEK)
    fireEvent.click(await copyButton())
    fireEvent.click(await screen.findByRole('button', { name: 'В сегодня?' }))

    await waitFor(() => expect(createMeal).toHaveBeenCalledTimes(1))
    const sent = createMeal.mock.calls[0]?.[0] as { timestamp: string; foodName: string }
    expect(sent.foodName).toBe('Овсянка с бананом')

    const at = new Date(sent.timestamp)
    expect(at.getDate()).toBe(14)
    // 05:30 UTC at +180 is the 08:30 the row displays.
    expect(`${at.getHours()}:${at.getMinutes()}`).toBe('8:30')
  })

  test('a primed button gives up rather than waiting to fire', async () => {
    // Otherwise a mis-tap leaves something armed that the next stray tap logs.
    renderToday(LAST_WEEK)
    fireEvent.click(await copyButton())
    await screen.findByRole('button', { name: 'В сегодня?' })

    await vi.advanceTimersByTimeAsync(5000)

    await copyButton()
    expect(screen.queryByRole('button', { name: 'В сегодня?' })).not.toBeInTheDocument()
    expect(createMeal).not.toHaveBeenCalled()
  })

  test('confirms, because the day it landed on is not the one on screen', async () => {
    renderToday(LAST_WEEK)
    fireEvent.click(await copyButton())
    fireEvent.click(await screen.findByRole('button', { name: 'В сегодня?' }))

    expect(await screen.findByText('В сегодня')).toBeInTheDocument()
  })

  test('becomes copyable again after the confirmation clears', async () => {
    renderToday(LAST_WEEK)
    fireEvent.click(await copyButton())
    fireEvent.click(await screen.findByRole('button', { name: 'В сегодня?' }))
    await screen.findByText('В сегодня')

    await vi.advanceTimersByTimeAsync(3000)
    await copyButton()
  })

  test('a failed copy surfaces the error and stays copyable', async () => {
    createMeal.mockRejectedValue(new Error('нет сети'))
    renderToday(LAST_WEEK)
    fireEvent.click(await copyButton())
    fireEvent.click(await screen.findByRole('button', { name: 'В сегодня?' }))

    await waitFor(() => expect(useUi.getState().lastError).toBe('нет сети'))
    await copyButton()
  })
})
