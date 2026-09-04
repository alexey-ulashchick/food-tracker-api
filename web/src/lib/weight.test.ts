import { describe, expect, test } from 'vitest'
import {
  TREND_WEEKS,
  formatKg,
  formatTrend,
  latestWeight,
  trendKgPerWeek,
  trendTone,
  weekDelta,
  weeklyAverages,
  weightYDomain,
} from './weight'

const p = (date: string, kg: number) => ({ date, kg })

describe('weeklyAverages', () => {
  test('buckets by ISO week and averages within it', () => {
    // 2026-08-31 is a Monday; 2026-09-06 the Sunday that closes that week.
    const weeks = weeklyAverages([p('2026-08-31', 80), p('2026-09-06', 78)])
    expect(weeks).toEqual([{ weekStart: '2026-08-31', avgKg: 79 }])
  })

  test('splits samples across week boundaries', () => {
    const weeks = weeklyAverages([p('2026-09-06', 80), p('2026-09-07', 78)])
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-08-31', '2026-09-07'])
  })

  test('sorts ascending regardless of input order', () => {
    const weeks = weeklyAverages([p('2026-09-14', 77), p('2026-08-31', 80), p('2026-09-07', 78)])
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14'])
  })

  test('no samples yields no weeks', () => {
    expect(weeklyAverages([])).toEqual([])
  })

  test('ignores non-finite readings rather than poisoning the mean', () => {
    const weeks = weeklyAverages([p('2026-08-31', 80), p('2026-09-01', Number.NaN)])
    expect(weeks[0]?.avgKg).toBe(80)
  })
})

describe('trendKgPerWeek', () => {
  // Four complete weeks losing exactly 0.5 kg each.
  const losing = [
    p('2026-08-03', 82),
    p('2026-08-10', 81.5),
    p('2026-08-17', 81),
    p('2026-08-24', 80.5),
  ]

  test('fits a clean downward slope', () => {
    expect(trendKgPerWeek(losing, '2026-08-31')).toBeCloseTo(-0.5, 9)
  })

  test('fits a clean upward slope', () => {
    const gaining = losing.map((x, i) => p(x.date, 80 + i * 0.5))
    expect(trendKgPerWeek(gaining, '2026-08-31')).toBeCloseTo(0.5, 9)
  })

  test('a flat series has zero slope', () => {
    const flat = losing.map((x) => p(x.date, 80))
    expect(trendKgPerWeek(flat, '2026-08-31')).toBe(0)
  })

  // The current week is still accumulating and would drag the line.
  test('excludes the in-progress week', () => {
    const withThisWeek = [...losing, p('2026-09-02', 60)]
    // 2026-09-02 falls in the week starting 2026-08-31, which is "this" week.
    expect(trendKgPerWeek(withThisWeek, '2026-09-04')).toBeCloseTo(-0.5, 9)
  })

  test('uses at most the last four complete weeks', () => {
    const long = [
      p('2026-07-06', 100), // far outlier, must be ignored
      ...losing,
    ]
    expect(trendKgPerWeek(long, '2026-08-31')).toBeCloseTo(-0.5, 9)
    expect(TREND_WEEKS).toBe(4)
  })

  test('falls back to two complete weeks so the pill appears early', () => {
    const two = [p('2026-08-17', 81), p('2026-08-24', 80)]
    expect(trendKgPerWeek(two, '2026-08-31')).toBeCloseTo(-1, 9)
  })

  test('returns null when a line cannot be fitted', () => {
    expect(trendKgPerWeek([], '2026-08-31')).toBeNull()
    expect(trendKgPerWeek([p('2026-08-24', 80)], '2026-08-31')).toBeNull()
    // One complete week plus the current one is still a single usable point.
    expect(trendKgPerWeek([p('2026-08-24', 80), p('2026-09-01', 79)], '2026-08-31')).toBeNull()
  })

  test('several readings in a week are averaged before the fit', () => {
    const noisy = [
      p('2026-08-17', 82),
      p('2026-08-18', 80), // same week, mean 81
      p('2026-08-24', 80),
    ]
    expect(trendKgPerWeek(noisy, '2026-08-31')).toBeCloseTo(-1, 9)
  })
})

describe('trend presentation', () => {
  test('losing weight reads as down, gaining as up', () => {
    expect(trendTone(-0.25)).toBe('down')
    expect(trendTone(0.25)).toBe('up')
    expect(trendTone(0)).toBe('up')
  })

  test('formats two decimals with an explicit sign', () => {
    expect(formatTrend(-0.25)).toBe('−0,25 кг/нед')
    expect(formatTrend(0.4)).toBe('+0,40 кг/нед')
    expect(formatTrend(0)).toBe('+0,00 кг/нед')
  })

  test('formatKg keeps one decimal', () => {
    expect(formatKg(78.42)).toBe('78,4')
    expect(formatKg(80)).toBe('80,0')
  })
})

describe('latestWeight', () => {
  test('picks the newest reading whatever the order', () => {
    expect(latestWeight([p('2026-08-01', 80), p('2026-09-01', 78)])).toEqual(p('2026-09-01', 78))
    expect(latestWeight([p('2026-09-01', 78), p('2026-08-01', 80)])).toEqual(p('2026-09-01', 78))
  })

  test('no readings yields null', () => {
    expect(latestWeight([])).toBeNull()
  })
})

describe('weekDelta', () => {
  test('compares against a reading at least a week old', () => {
    expect(weekDelta([p('2026-08-25', 80), p('2026-09-01', 79)])).toBeCloseTo(-1, 9)
  })

  test('is exactly seven days inclusive', () => {
    expect(weekDelta([p('2026-08-25', 80), p('2026-09-01', 79)])).not.toBeNull()
  })

  test('null when nothing is old enough to compare with', () => {
    expect(weekDelta([p('2026-09-01', 79), p('2026-08-30', 80)])).toBeNull()
    expect(weekDelta([])).toBeNull()
  })

  test('prefers the most recent qualifying reading', () => {
    const points = [p('2026-08-01', 85), p('2026-08-25', 80), p('2026-09-01', 79)]
    expect(weekDelta(points)).toBeCloseTo(-1, 9)
  })
})

describe('weightYDomain', () => {
  test('pads around the range', () => {
    const d = weightYDomain([
      { weekStart: '2026-08-24', avgKg: 78 },
      { weekStart: '2026-08-31', avgKg: 80 },
    ])
    expect(d.lo).toBeLessThan(78)
    expect(d.hi).toBeGreaterThan(80)
  })

  // A flat series would otherwise collapse to a zero-height domain.
  test('a constant series still gets a half-kilo of padding', () => {
    const d = weightYDomain([
      { weekStart: '2026-08-24', avgKg: 80 },
      { weekStart: '2026-08-31', avgKg: 80 },
    ])
    expect(d.lo).toBeCloseTo(79.5, 9)
    expect(d.hi).toBeCloseTo(80.5, 9)
  })

  test('no weeks falls back to a usable domain', () => {
    expect(weightYDomain([])).toEqual({ lo: 0, hi: 1 })
  })
})
