import { describe, expect, test } from 'vitest'
import {
  EMPTY_ROLLUP,
  balanceKcal,
  balanceTone,
  buildCalorieDays,
  buildDayTotals,
  calorieMetrics,
  calorieYDomain,
  chartWindow,
  compliance,
  effectiveGoal,
  formatBalance,
  formatFatEquivalent,
  goalExtension,
  metricsRange,
  mondayOf,
  rollup,
} from './calorieMetrics'

const goals = (entries: Array<[string, number]>) => new Map(entries)
const eaten = (entries: Array<[string, number]>) => new Map(entries)
const totals = (g: Array<[string, number]>, e: Array<[string, number]> = []) => ({
  goalByDay: goals(g),
  eatenByDay: eaten(e),
})

describe('mondayOf', () => {
  // 2026-09-04 is a Friday.
  test('walks back to Monday of the same ISO week', () => {
    expect(mondayOf('2026-09-04')).toBe('2026-08-31')
  })

  test('a Monday maps to itself', () => {
    expect(mondayOf('2026-08-31')).toBe('2026-08-31')
  })

  // The trap: getDay() reports 0 for Sunday, which would jump forward a week.
  test('Sunday belongs to the week that started six days earlier', () => {
    expect(mondayOf('2026-09-06')).toBe('2026-08-31')
  })

  test('crosses a month boundary', () => {
    expect(mondayOf('2026-09-01')).toBe('2026-08-31')
  })
})

describe('effectiveGoal', () => {
  test('prefers the explicit goal for the day', () => {
    expect(effectiveGoal('2026-09-04', goals([['2026-09-04', 2650]]))).toBe(2650)
  })

  test('averages explicit goals within the surrounding fortnight', () => {
    const g = goals([
      ['2026-09-01', 2000],
      ['2026-09-08', 3000],
    ])
    expect(effectiveGoal('2026-09-04', g)).toBe(2500)
  })

  test('ignores goals more than seven days away', () => {
    const g = goals([['2026-08-20', 2000]])
    expect(effectiveGoal('2026-09-04', g)).toBeNull()
  })

  test('is inclusive at exactly seven days out', () => {
    expect(effectiveGoal('2026-09-04', goals([['2026-08-28', 2000]]))).toBe(2000)
    expect(effectiveGoal('2026-09-04', goals([['2026-09-11', 2000]]))).toBe(2000)
  })

  test('returns null when nothing is nearby', () => {
    expect(effectiveGoal('2026-09-04', goals([]))).toBeNull()
  })

  test('does not count the day itself twice when averaging', () => {
    // Only neighbours contribute, so a lone neighbour gives exactly its value.
    expect(effectiveGoal('2026-09-04', goals([['2026-09-05', 1234]]))).toBe(1234)
  })
})

describe('rollup', () => {
  test('a day with no usable goal is skipped entirely', () => {
    expect(rollup('2026-09-01', 3, totals([]))).toEqual(EMPTY_ROLLUP)
  })

  test('a day with no meals counts as a perfect match', () => {
    const r = rollup('2026-09-01', 1, totals([['2026-09-01', 2000]]))
    expect(r).toEqual({ onTargetDays: 1, totalDays: 1, totalEaten: 2000, totalGoal: 2000 })
    expect(balanceKcal(r)).toBe(0)
    expect(compliance(r)).toBe(1)
  })

  test('on-target is inclusive at both 0.9 and 1.1', () => {
    const at = (kcal: number) =>
      rollup('2026-09-01', 1, totals([['2026-09-01', 2000]], [['2026-09-01', kcal]])).onTargetDays

    expect(at(1800)).toBe(1) // exactly 0.9
    expect(at(2200)).toBe(1) // exactly 1.1
    expect(at(1799)).toBe(0)
    expect(at(2201)).toBe(0)
  })

  test('a zero or negative goal is not usable', () => {
    expect(rollup('2026-09-01', 1, totals([['2026-09-01', 0]]))).toEqual(EMPTY_ROLLUP)
    expect(rollup('2026-09-01', 1, totals([['2026-09-01', -100]]))).toEqual(EMPTY_ROLLUP)
  })

  test('accumulates eaten and goal across the window', () => {
    const r = rollup(
      '2026-09-01',
      3,
      totals(
        [
          ['2026-09-01', 2000],
          ['2026-09-02', 2000],
          ['2026-09-03', 2000],
        ],
        [
          ['2026-09-01', 2100],
          ['2026-09-02', 1500],
          // third day has no meals → counts as 2000
        ],
      ),
    )
    expect(r.totalDays).toBe(3)
    expect(r.totalEaten).toBe(2100 + 1500 + 2000)
    expect(r.totalGoal).toBe(6000)
    // 2100/2000 = 1.05 on target; 1500/2000 = 0.75 off; blank day on target.
    expect(r.onTargetDays).toBe(2)
  })

  test('an explicitly zero intake is a real zero, not a blank day', () => {
    const r = rollup('2026-09-01', 1, totals([['2026-09-01', 2000]], [['2026-09-01', 0]]))
    expect(r.totalEaten).toBe(0)
    expect(r.onTargetDays).toBe(0)
  })
})

describe('calorieMetrics', () => {
  const everyDay = (from: string, days: number, goal: number): Array<[string, number]> =>
    Array.from({ length: days }, (_, i) => {
      const d = new Date(2026, 0, 1)
      d.setTime(new Date(`${from}T00:00:00`).getTime() + i * 86_400_000)
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`
      return [iso, goal] as [string, number]
    })

  test('this week spans Monday to today inclusive', () => {
    // Friday 2026-09-04 → Mon..Fri is five days.
    const m = calorieMetrics(totals(everyDay('2026-08-31', 60, 2000)), '2026-09-04')
    expect(m.thisWeek.totalDays).toBe(5)
  })

  test('a Monday still counts one day, not zero', () => {
    const m = calorieMetrics(totals(everyDay('2026-08-31', 60, 2000)), '2026-08-31')
    expect(m.thisWeek.totalDays).toBe(1)
  })

  test('the long window is the 42 days before this Monday', () => {
    const m = calorieMetrics(totals(everyDay('2026-07-01', 120, 2000)), '2026-09-04')
    expect(m.lastSixWeeks.totalDays).toBe(42)
  })

  // The two windows must not overlap, or this week is double counted.
  test('the long window ends the day before this Monday', () => {
    const monday = mondayOf('2026-09-04')
    const range = metricsRange('2026-09-04')
    expect(range.to).toBe('2026-09-04')
    // 42 days back from Monday, and the rollup covers [start, Monday).
    expect(range.from).toBe('2026-07-20')
    const m = calorieMetrics(totals([[monday, 2000]]), '2026-09-04')
    // Only this Monday has a goal, so the six-week window sees it only via the
    // ±7-day average — never as the day itself.
    expect(m.lastSixWeeks.totalDays).toBeLessThanOrEqual(7)
  })

  test('no data at all yields empty rollups rather than throwing', () => {
    const m = calorieMetrics(totals([]), '2026-09-04')
    expect(m.thisWeek).toEqual(EMPTY_ROLLUP)
    expect(m.lastSixWeeks).toEqual(EMPTY_ROLLUP)
    expect(compliance(m.thisWeek)).toBe(0)
  })
})

describe('formatBalance', () => {
  test('signs and groups the number', () => {
    expect(formatBalance(1240)).toMatch(/^\+1\s?240 ккал$/)
    expect(formatBalance(-830)).toBe('−830 ккал')
  })

  test('zero has no sign', () => {
    expect(formatBalance(0)).toBe('0 ккал')
    expect(formatBalance(0.4)).toBe('0 ккал')
  })

  test('uses the Russian minus, not a hyphen', () => {
    expect(formatBalance(-100).startsWith('−')).toBe(true)
  })
})

describe('balanceTone', () => {
  test('within fifty kcal reads as neutral', () => {
    expect(balanceTone(0)).toBe('neutral')
    expect(balanceTone(49)).toBe('neutral')
    expect(balanceTone(-49)).toBe('neutral')
  })

  test('surplus is caution, deficit is positive', () => {
    expect(balanceTone(50)).toBe('surplus')
    expect(balanceTone(-50)).toBe('deficit')
  })
})

describe('formatFatEquivalent', () => {
  test('converts a surplus at 7700 kcal per kg', () => {
    // 7700 kcal over 6 weeks is 1 kg total, ~0.17 kg/week.
    expect(formatFatEquivalent(7700, 6)).toBe('1,00 кг (0,17 кг/нед)')
  })

  test('a deficit or zero has no fat equivalent', () => {
    expect(formatFatEquivalent(0, 6)).toBeNull()
    expect(formatFatEquivalent(-5000, 6)).toBeNull()
  })

  test('zero weeks is rejected rather than dividing by zero', () => {
    expect(formatFatEquivalent(7700, 0)).toBeNull()
  })
})

describe('chart window', () => {
  test('is 29 days centred on today', () => {
    const w = chartWindow('2026-09-04', 0)
    expect(w.from).toBe('2026-08-21')
    expect(w.to).toBe('2026-09-18')
    expect(buildCalorieDays(w.from, w.to, totals([]))).toHaveLength(29)
  })

  test('pages by a fortnight in each direction', () => {
    expect(chartWindow('2026-09-04', -14).to).toBe('2026-09-04')
    expect(chartWindow('2026-09-04', 14).from).toBe('2026-09-04')
  })

  test('a day with neither goal nor meals still yields a row', () => {
    const days = buildCalorieDays('2026-09-01', '2026-09-02', totals([]))
    expect(days).toEqual([
      { date: '2026-09-01', eaten: null, goal: null },
      { date: '2026-09-02', eaten: null, goal: null },
    ])
  })
})

describe('calorieYDomain', () => {
  // Anchoring at zero would flatten the variation that matters.
  test('does not start at zero when values are high', () => {
    const d = calorieYDomain([{ date: 'x', eaten: 2000, goal: 2100 }])
    expect(d.lo).toBeGreaterThan(0)
    expect(d.lo).toBeLessThan(2000)
  })

  test('clamps the floor at zero for small values', () => {
    expect(calorieYDomain([{ date: 'x', eaten: 100, goal: 120 }]).lo).toBe(0)
  })

  test('leaves headroom above the maximum', () => {
    const d = calorieYDomain([{ date: 'x', eaten: 2000, goal: 2000 }])
    expect(d.hi).toBeGreaterThan(2000)
  })

  test('an empty window falls back to a usable domain', () => {
    expect(calorieYDomain([])).toEqual({ lo: 0, hi: 100 })
    expect(calorieYDomain([{ date: 'x', eaten: null, goal: null }])).toEqual({ lo: 0, hi: 100 })
  })

  test('lo is always below hi', () => {
    for (const v of [50, 500, 2000, 9000]) {
      const d = calorieYDomain([{ date: 'x', eaten: v, goal: v }])
      expect(d.lo).toBeLessThan(d.hi)
    }
  })
})

describe('goalExtension', () => {
  test('carries the last known goal forward', () => {
    const days = [
      { date: '2026-09-01', eaten: null, goal: 2000 },
      { date: '2026-09-02', eaten: null, goal: null },
      { date: '2026-09-03', eaten: null, goal: null },
    ]
    expect(goalExtension(days)).toEqual([
      { date: '2026-09-01', goal: 2000 },
      { date: '2026-09-02', goal: 2000 },
      { date: '2026-09-03', goal: 2000 },
    ])
  })

  test('starts at the last real goal, not the first', () => {
    const days = [
      { date: '2026-09-01', eaten: null, goal: 2000 },
      { date: '2026-09-02', eaten: null, goal: 2500 },
      { date: '2026-09-03', eaten: null, goal: null },
    ]
    expect(goalExtension(days).map((d) => d.date)).toEqual(['2026-09-02', '2026-09-03'])
    expect(goalExtension(days).at(-1)?.goal).toBe(2500)
  })

  test('no goals at all means nothing to extend', () => {
    expect(goalExtension([{ date: 'x', eaten: 100, goal: null }])).toEqual([])
  })
})

describe('buildDayTotals', () => {
  test('sums several meals on the same local date', () => {
    const t = buildDayTotals(
      [
        { localDate: '2026-09-04', calories: 300 },
        { localDate: '2026-09-04', calories: 450 },
        { localDate: '2026-09-05', calories: 100 },
      ],
      [{ date: '2026-09-04', calorieGoal: 2000 }],
    )
    expect(t.eatenByDay.get('2026-09-04')).toBe(750)
    expect(t.eatenByDay.get('2026-09-05')).toBe(100)
    expect(t.goalByDay.get('2026-09-04')).toBe(2000)
  })

  // Buckets come from the server-computed localDate, never from client TZ maths.
  test('keys meals by their server-supplied localDate', () => {
    const t = buildDayTotals([{ localDate: '2026-06-29', calories: 500 }], [])
    expect([...t.eatenByDay.keys()]).toEqual(['2026-06-29'])
  })
})
