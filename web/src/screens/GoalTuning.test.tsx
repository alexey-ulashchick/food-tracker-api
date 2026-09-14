import { createQueryClient } from '@/api/keys'
import { GoalTuningScreen } from '@/screens/GoalTuning'
import { DEFAULT_TUNING } from '@shared/goalTuning.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// Two things make this screen worth its own tests. The preview has to follow
// the fields before anything is saved — that is the whole reason the screen
// exists rather than a note in the README — and the bounds it enforces have to
// be the same ones the server enforces, or the form offers a value that 400s.

const getSettings = vi.fn()
const updateSettings = vi.fn()
const syncTraining = vi.fn()

vi.mock('@/api/endpoints', () => ({
  getSettings: () => getSettings(),
  updateSettings: (patch: unknown) => updateSettings(patch),
  syncTraining: (force: boolean) => syncTraining(force),
}))

const settings = (tuning = DEFAULT_TUNING) => ({
  userId: 'u',
  baseCalories: 1450,
  proteinG: 140,
  fatG: 60,
  intervalsAthleteId: 'i1',
  intervalsKeyHint: '1234',
  intervalsSyncedAt: null,
  goalTuning: tuning,
  updatedAt: '2026-09-14T00:00:00.000Z',
})

function renderScreen() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <GoalTuningScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const field = (label: string) => screen.getByRole('textbox', { name: label })
const saveButton = () => screen.getByRole('button', { name: /Сохранить/ })

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(settings())
  updateSettings.mockReset().mockImplementation(() => Promise.resolve(settings()))
  syncTraining.mockReset().mockResolvedValue({ configured: true, written: 1 })
})

describe('the form', () => {
  test('shows ratios as percentages, not fractions', async () => {
    // 0.95 stored is 95% read. Nobody types 0.95 into a coefficient box.
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))
    expect(field('Z2 короткий')).toHaveValue('70')
  })

  test('shows the other units as they are', async () => {
    renderScreen()
    await waitFor(() => expect(field('За тренировку')).toHaveValue('250'))
    expect(field('Короткий до')).toHaveValue('75')
    expect(field('Минимум')).toHaveValue('600')
  })

  test('there is nothing to save until something changes', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))
    expect(saveButton()).toBeDisabled()
  })

  test('saves a whole tuning, converted back to fractions', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))

    fireEvent.change(field('VO₂max'), { target: { value: '105' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    const sent = updateSettings.mock.calls[0]?.[0] as { goalTuning: typeof DEFAULT_TUNING }
    expect(sent.goalTuning.vo2max).toBeCloseTo(1.05, 5)
    // A whole tuning, so the server can store the differences itself.
    expect(sent.goalTuning.z2Short).toBe(DEFAULT_TUNING.z2Short)
  })
})

describe('the preview', () => {
  test('follows the field before anything is saved', async () => {
    renderScreen()
    // 1200 kJ at the default 95%.
    await waitFor(() => expect(screen.getByText('1140 ккал')).toBeInTheDocument())

    fireEvent.change(field('VO₂max'), { target: { value: '50' } })

    // Same work, half the coefficient.
    expect(await screen.findByText('600 ккал')).toBeInTheDocument()
    expect(screen.queryByText('1140 ккал')).not.toBeInTheDocument()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  test('follows a band edge, which reclassifies an example', async () => {
    renderScreen()
    // The two-hour Z2 example is "medium" by default: 1800 × 80%.
    await waitFor(() => expect(screen.getByText('1440 ккал')).toBeInTheDocument())

    // Widen the short band past two hours; it becomes 1800 × 70%. 130 and not
    // 180, because the long edge is 150 and a short edge above it is the
    // inverted pair the form refuses to save — previewing a state you cannot
    // save is not what this test is for.
    fireEvent.change(field('Короткий до'), { target: { value: '130' } })

    expect(await screen.findByText('1260 ккал')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Сохранить/ })).toBeEnabled()
  })

  test('follows the strength bonus', async () => {
    renderScreen()
    await waitFor(() => expect(screen.getByText('250 ккал')).toBeInTheDocument())

    fireEvent.change(field('За тренировку'), { target: { value: '400' } })
    expect(await screen.findByText('400 ккал')).toBeInTheDocument()
  })
})

describe('bounds', () => {
  test('refuses to save a value the server would reject', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))

    // The ratio ceiling is 200%.
    fireEvent.change(field('VO₂max'), { target: { value: '5000' } })

    expect(saveButton()).toBeDisabled()
    expect(await screen.findByText(/Вне допустимых границ/)).toBeInTheDocument()
  })

  test('refuses text', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))

    fireEvent.change(field('VO₂max'), { target: { value: 'сто' } })
    expect(saveButton()).toBeDisabled()
  })

  test('refuses inverted band edges, and says which pair', async () => {
    renderScreen()
    await waitFor(() => expect(field('Короткий до')).toHaveValue('75'))

    fireEvent.change(field('Короткий до'), { target: { value: '400' } })

    expect(await screen.findByText(/«Короткий до» не может быть больше/)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  test('accepts a comma as a decimal separator', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))

    fireEvent.change(field('VO₂max'), { target: { value: '97,5' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(updateSettings).toHaveBeenCalled())
    const sent = updateSettings.mock.calls[0]?.[0] as { goalTuning: typeof DEFAULT_TUNING }
    expect(sent.goalTuning.vo2max).toBeCloseTo(0.975, 5)
  })
})

describe('resetting and re-syncing', () => {
  test('offers a reset only when something is off the defaults', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))
    expect(screen.queryByRole('button', { name: 'Вернуть по умолчанию' })).not.toBeInTheDocument()
  })

  test('reset sends null, which is how the server clears every dial', async () => {
    getSettings.mockResolvedValue(settings({ ...DEFAULT_TUNING, vo2max: 1 }))
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('100'))

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть по умолчанию' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ goalTuning: null }))
  })

  test('re-syncing forces a fetch, because the stored goals used the old numbers', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))

    fireEvent.click(screen.getByRole('button', { name: 'Пересчитать цели' }))
    await waitFor(() => expect(syncTraining).toHaveBeenCalledWith(true))
  })

  test('discards edits without touching the server', async () => {
    renderScreen()
    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))

    fireEvent.change(field('VO₂max'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отменить правки' }))

    await waitFor(() => expect(field('VO₂max')).toHaveValue('95'))
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
