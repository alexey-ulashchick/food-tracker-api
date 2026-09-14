import { formatLocalTime } from '@/lib/formatLocalTime'
import type { ServerMeal } from '@shared/types.ts'
import { describe, expect, test } from 'vitest'
import { copyTimestamp, mealCopy } from './copyMeal'

// The rule under test: the copy lands at the clock time the original row
// SHOWS. Anything else puts an entry at a time the user never saw, and the
// cross-timezone case is where that goes wrong quietly.

const meal = (over: Partial<ServerMeal> = {}): ServerMeal => ({
  id: 'm',
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
  localDate: '2026-09-07',
  ...over,
})

/** Local hours and minutes of an instant, as the viewer's clock reads it. */
const localClock = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('copyTimestamp', () => {
  test('lands on today, not on the day it was copied from', () => {
    const iso = copyTimestamp(meal(), '2026-09-14')
    const d = new Date(iso)
    expect(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`).toBe('2026-9-14')
  })

  test('keeps the clock time the row displays', () => {
    // 05:30 UTC at +180 is 08:30 — what formatLocalTime renders.
    const source = meal()
    expect(formatLocalTime(source.timestamp, source.tzOffsetMin)).toContain('08:30')
    expect(localClock(copyTimestamp(source, '2026-09-14'))).toBe('08:30')
  })

  test('a breakfast copied in the evening still sits at breakfast time', () => {
    // Not `now`: three meals copied in a row would otherwise pile up at the
    // current minute, ordered by which was tapped first rather than eaten.
    const evening = new Date('2026-09-14T21:00:00')
    expect(localClock(copyTimestamp(meal(), '2026-09-14', evening))).toBe('08:30')
  })

  test('a legacy row with no offset uses the device clock', () => {
    // tz_offset_min predates some rows. Reading them with the device offset is
    // what formatLocalTime does, so the copy agrees with the display.
    const source = meal({ tzOffsetMin: null })
    const shown = formatLocalTime(source.timestamp, null)
    expect(localClock(copyTimestamp(source, '2026-09-14'))).toBe(shown)
  })

  test('survives a timestamp it cannot parse', () => {
    // Midnight today rather than an Invalid Date the server would reject.
    const iso = copyTimestamp(meal({ timestamp: 'nonsense' }), '2026-09-14')
    expect(Number.isNaN(new Date(iso).getTime())).toBe(false)
    expect(localClock(iso)).toBe('00:00')
  })
})

describe('mealCopy', () => {
  test('carries the food across unchanged', () => {
    const copy = mealCopy(meal(), '2026-09-14')
    expect(copy).toMatchObject({
      meal: 'Breakfast',
      emoji: '🥞',
      foodName: 'Овсянка с бананом',
      calories: 420,
      protein: 14,
      carbs: 70,
      fats: 8,
    })
  })

  test('sends no id, so the server creates a new row rather than moving one', () => {
    expect(mealCopy(meal(), '2026-09-14')).not.toHaveProperty('id')
    expect(mealCopy(meal(), '2026-09-14')).not.toHaveProperty('localDate')
  })

  test('keeps a missing emoji missing rather than inventing one', () => {
    expect(mealCopy(meal({ emoji: null }), '2026-09-14').emoji).toBeNull()
  })
})
