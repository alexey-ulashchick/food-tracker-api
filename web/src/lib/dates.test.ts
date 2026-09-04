import { describe, expect, test } from 'vitest'
import {
  addDays,
  dateRange,
  dayMonth,
  dayOfMonth,
  diffDays,
  fromIsoDate,
  monthShort,
  relativeDayTitle,
  toIsoDate,
  weekdayLong,
  weekdayShortDate,
} from './dates'
import { formatLocalTime, gmtSuffix } from './formatLocalTime'

describe('toIsoDate', () => {
  // The bug this guards: toISOString() is UTC, so west of Greenwich it reports
  // tomorrow's date for most of the evening.
  test('uses the local calendar, not UTC', () => {
    const local = new Date(2026, 8, 4, 23, 30) // 4 Sept, 23:30 local
    expect(toIsoDate(local)).toBe('2026-09-04')
  })

  test('pads month and day', () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  test('round-trips through fromIsoDate', () => {
    for (const iso of ['2026-01-01', '2026-02-28', '2026-09-04', '2026-12-31']) {
      expect(toIsoDate(fromIsoDate(iso))).toBe(iso)
    }
  })

  test('fromIsoDate parses local midnight, not UTC midnight', () => {
    const d = fromIsoDate('2026-09-04')
    expect(d.getHours()).toBe(0)
    expect(d.getDate()).toBe(4)
  })
})

describe('addDays', () => {
  test('moves forward and back', () => {
    expect(addDays('2026-09-04', 1)).toBe('2026-09-05')
    expect(addDays('2026-09-04', -1)).toBe('2026-09-03')
    expect(addDays('2026-09-04', 0)).toBe('2026-09-04')
  })

  test('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
  })

  test('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  test('survives large jumps', () => {
    expect(addDays('2026-09-04', 365)).toBe('2027-09-04')
    // Feb 2025 and Feb 2026 both have 28 days, so 730 days back is the same
    // calendar day two years earlier.
    expect(addDays('2026-09-04', -730)).toBe('2024-09-04')
    // Crossing a 29 February shifts it by one.
    expect(addDays('2028-03-01', -730)).toBe('2026-03-02')
  })
})

describe('diffDays', () => {
  test('counts whole days in both directions', () => {
    expect(diffDays('2026-09-04', '2026-09-04')).toBe(0)
    expect(diffDays('2026-09-04', '2026-09-11')).toBe(7)
    expect(diffDays('2026-09-11', '2026-09-04')).toBe(-7)
  })

  // Rounding matters here: a DST shift makes one "day" 23 or 25 hours long.
  test('is exact across a month boundary', () => {
    expect(diffDays('2026-08-31', '2026-09-01')).toBe(1)
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364)
  })
})

describe('dateRange', () => {
  test('is inclusive on both ends', () => {
    expect(dateRange('2026-09-02', '2026-09-05')).toEqual([
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ])
  })

  test('a single day yields one entry', () => {
    expect(dateRange('2026-09-04', '2026-09-04')).toEqual(['2026-09-04'])
  })

  test('an inverted range yields nothing', () => {
    expect(dateRange('2026-09-05', '2026-09-02')).toEqual([])
  })

  test('spans a month boundary without gaps', () => {
    const r = dateRange('2026-08-30', '2026-09-02')
    expect(r).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'])
  })

  test('produces exactly 29 days for the History chart window', () => {
    expect(dateRange(addDays('2026-09-04', -14), addDays('2026-09-04', 14))).toHaveLength(29)
  })
})

describe('display formatting', () => {
  test('labels are Russian', () => {
    expect(weekdayLong('2026-09-04')).toBe('пятница')
    expect(weekdayShortDate('2026-09-04')).toMatch(/сент/)
    expect(dayMonth('2026-09-04')).toMatch(/сент/)
    expect(monthShort('2026-09-04')).toMatch(/сент/)
  })

  test('dayOfMonth is unpadded', () => {
    expect(dayOfMonth('2026-09-04')).toBe('4')
    expect(dayOfMonth('2026-09-14')).toBe('14')
  })
})

describe('relativeDayTitle', () => {
  const today = '2026-09-04'

  test('names the three days around today', () => {
    expect(relativeDayTitle('2026-09-04', today)).toBe('Сегодня')
    expect(relativeDayTitle('2026-09-03', today)).toBe('Вчера')
    expect(relativeDayTitle('2026-09-05', today)).toBe('Завтра')
  })

  test('falls back to a capitalised weekday further out', () => {
    expect(relativeDayTitle('2026-09-01', today)).toBe('Вторник')
    expect(relativeDayTitle('2026-09-10', today)).toBe('Четверг')
  })
})

describe('gmtSuffix', () => {
  test('renders whole hours', () => {
    expect(gmtSuffix(180)).toBe('GMT+3')
    expect(gmtSuffix(-480)).toBe('GMT−8')
    expect(gmtSuffix(0)).toBe('GMT+0')
  })

  test('renders half-hour and 45-minute zones', () => {
    expect(gmtSuffix(330)).toBe('GMT+5:30') // India
    expect(gmtSuffix(345)).toBe('GMT+5:45') // Nepal
    expect(gmtSuffix(-210)).toBe('GMT−3:30') // Newfoundland
  })
})

describe('formatLocalTime', () => {
  // The device is pinned so the "same offset" branch is deterministic.
  const deviceInMoscow = { getTimezoneOffset: () => -180 } as Date

  test('renders the time in the meal own timezone', () => {
    // 06:00 UTC is 09:00 in Moscow (+180).
    expect(formatLocalTime('2026-06-29T06:00:00.000Z', 180, deviceInMoscow)).toBe('09:00')
  })

  test('adds no hint when the meal offset matches the device', () => {
    expect(formatLocalTime('2026-06-29T06:00:00.000Z', 180, deviceInMoscow)).not.toMatch(/GMT/)
  })

  // The whole point of the column: after travelling, a meal keeps the clock
  // time it was eaten at, plus a hint that it belongs to another zone.
  test('adds a GMT hint when the offsets differ', () => {
    // Meal eaten in LA (−480) at 01:00 UTC → 17:00 the previous day, PT.
    expect(formatLocalTime('2026-06-29T01:00:00.000Z', -480, deviceInMoscow)).toBe('17:00 GMT−8')
  })

  test('a legacy null offset uses the device and shows no hint', () => {
    expect(formatLocalTime('2026-06-29T06:00:00.000Z', null, deviceInMoscow)).toBe('09:00')
  })

  test('pads to two digits', () => {
    expect(
      formatLocalTime('2026-06-29T04:05:00.000Z', 0, { getTimezoneOffset: () => 0 } as Date),
    ).toBe('04:05')
  })

  test('accepts fractional seconds and a plain ISO timestamp', () => {
    const device = { getTimezoneOffset: () => 0 } as Date
    expect(formatLocalTime('2026-06-29T12:34:56.789Z', 0, device)).toBe('12:34')
    expect(formatLocalTime('2026-06-29T12:34:56Z', 0, device)).toBe('12:34')
  })

  test('an unparseable timestamp yields an empty string rather than NaN', () => {
    expect(formatLocalTime('not a date', 0)).toBe('')
  })

  test('rolls the clock correctly across midnight', () => {
    const device = { getTimezoneOffset: () => 0 } as Date
    // 22:00 UTC + 3h = 01:00 the next day in Moscow.
    expect(formatLocalTime('2026-06-29T22:00:00.000Z', 180, device)).toBe('01:00 GMT+3')
  })
})
