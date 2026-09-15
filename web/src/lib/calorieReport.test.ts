import type { ServerDaySummary, ServerWeight } from '@shared/types.ts'
import { describe, expect, test } from 'vitest'
import {
  INCOMPLETE_RATIO,
  buildCalorieReport,
  renderCalorieReportPdf,
  trimToObserved,
} from './calorieReport'

// The model first, then that the PDF actually carries its numbers. The PDF
// cannot be looked at here, so "carries" means the figures appear in the
// content stream — which together with pdf.test.ts's structural checks is as
// close to reading it as this environment gets.

const day = (
  date: string,
  eaten: { calories: number; protein?: number; carbs?: number; fats?: number } | null,
  goal: number | null,
): ServerDaySummary => ({
  date,
  color: 'gray',
  title: '',
  reason: '',
  eaten: {
    calories: eaten?.calories ?? 0,
    protein: eaten?.protein ?? 0,
    carbs: eaten?.carbs ?? 0,
    fats: eaten?.fats ?? 0,
  },
  goal:
    goal === null
      ? null
      : {
          dayType: 'training',
          calorieGoal: goal,
          proteinGGoal: 140,
          carbsGGoal: 300,
          fatGGoal: 60,
        },
})

const empty = (date: string) => day(date, null, null)

const weight = (date: string, kg: number): ServerWeight => ({
  id: date,
  userId: 'u',
  date,
  kg,
  source: null,
  createdAt: `${date}T00:00:00.000Z`,
})

describe('trimToObserved', () => {
  test('drops the empty days at each end', () => {
    // The fetched range is deliberately generous, so most of it is usually
    // nothing at all.
    const trimmed = trimToObserved([
      empty('2026-09-01'),
      empty('2026-09-02'),
      day('2026-09-03', { calories: 2000 }, null),
      day('2026-09-04', null, 2400),
      empty('2026-09-05'),
    ])
    expect(trimmed.map((d) => d.date)).toEqual(['2026-09-03', '2026-09-04'])
  })

  test('keeps an empty day in the middle, which is a real gap', () => {
    const trimmed = trimToObserved([
      day('2026-09-01', { calories: 2000 }, null),
      empty('2026-09-02'),
      day('2026-09-03', { calories: 2100 }, null),
    ])
    expect(trimmed).toHaveLength(3)
  })

  test('a range with nothing in it is empty, not one day of zeroes', () => {
    expect(trimToObserved([empty('2026-09-01'), empty('2026-09-02')])).toEqual([])
  })
})

describe('buildCalorieReport', () => {
  test('reports the observed range, not the range asked for', () => {
    const report = buildCalorieReport(
      [empty('2026-09-01'), day('2026-09-02', { calories: 2000 }, 2000), empty('2026-09-03')],
      [],
    )
    expect([report.from, report.to]).toEqual(['2026-09-02', '2026-09-02'])
  })

  test('averages over the counted days, not over every day', () => {
    // A day with no goal has no target to average against; including it would
    // drag the average goal towards zero.
    const report = buildCalorieReport(
      [
        day('2026-09-01', { calories: 2000 }, 2000),
        day('2026-09-02', { calories: 3000 }, 3000),
        day('2026-09-03', { calories: 9999 }, null),
      ],
      [],
    )
    expect(report.days).toHaveLength(3)
    expect(report.onTarget + report.offTarget).toBe(2)
    expect(report.incomplete).toBe(1)
    expect(report.avgGoal).toBe(2500)
    expect(report.avgEaten).toBe(2500)
  })

  test('every day falls into exactly one bucket', () => {
    // The three counts are the summary, so they have to partition the period
    // rather than merely describe parts of it.
    const report = buildCalorieReport(
      [
        day('2026-09-01', { calories: 2000 }, 2000),
        day('2026-09-02', { calories: 2600 }, 2000),
        day('2026-09-03', { calories: 900 }, 2000),
        day('2026-09-04', { calories: 2000 }, null),
      ],
      [],
    )
    expect([report.onTarget, report.offTarget, report.incomplete]).toEqual([1, 1, 2])
    expect(report.onTarget + report.offTarget + report.incomplete).toBe(report.days.length)
  })

  test('on target uses the same band as the History metrics', () => {
    // 0.9 to 1.1 of the goal. Two screens disagreeing on what counts would be
    // worse than either threshold being wrong.
    const report = buildCalorieReport(
      [
        day('2026-09-01', { calories: 1800 }, 2000), // exactly 0.90
        day('2026-09-02', { calories: 2200 }, 2000), // exactly 1.10
        day('2026-09-03', { calories: 1799 }, 2000), // just under
        day('2026-09-04', { calories: 2201 }, 2000), // just over
      ],
      [],
    )
    expect(report.onTarget).toBe(2)
    expect(report.days.map((d) => d.status)).toEqual([
      'onTarget',
      'onTarget',
      'offTarget',
      'offTarget',
    ])
  })

  test('a day with no goal is incomplete, not merely off target', () => {
    const report = buildCalorieReport([day('2026-09-01', { calories: 2000 }, null)], [])
    expect(report.days[0]?.status).toBe('incomplete')
    expect([report.onTarget, report.offTarget, report.incomplete]).toEqual([0, 0, 1])
  })

  test('carries the macros as they actually were', () => {
    const report = buildCalorieReport(
      [day('2026-09-01', { calories: 2000, protein: 150, carbs: 210, fats: 70 }, 2000)],
      [],
    )
    expect(report.days[0]).toMatchObject({ protein: 150, carbs: 210, fat: 70 })
    expect(report.avgProtein).toBe(150)
    expect(report.avgFat).toBe(70)
    expect(report.avgCarbs).toBe(210)
  })

  test('weight is the first and last reading inside the period', () => {
    const report = buildCalorieReport(
      [day('2026-09-02', { calories: 2000 }, 2000), day('2026-09-05', { calories: 2000 }, 2000)],
      [
        // Before the period: must not become the starting point.
        weight('2026-08-01', 90),
        weight('2026-09-02', 78.4),
        weight('2026-09-05', 77.1),
      ],
    )
    expect(report.weight).toEqual({ first: 78.4, last: 77.1, delta: 77.1 - 78.4 })
  })

  test('a single reading is not a change', () => {
    const report = buildCalorieReport(
      [day('2026-09-02', { calories: 2000 }, 2000)],
      [weight('2026-09-02', 78.4)],
    )
    expect(report.weight).toBeNull()
  })

  test('no goals at all leaves the averages null rather than zero', () => {
    // Zero would read as "you averaged nothing", which is a claim.
    const report = buildCalorieReport([day('2026-09-01', { calories: 2000 }, null)], [])
    expect(report.avgGoal).toBeNull()
    expect(report.avgEaten).toBeNull()
  })
})

describe('a day that was not finished being logged', () => {
  test('under the threshold it is incomplete', () => {
    // Nobody eats 55% of their target and stops; they forget dinner.
    const report = buildCalorieReport([day('2026-09-01', { calories: 1100 }, 2000)], [])
    expect(report.days[0]?.status).toBe('incomplete')
    expect(report.incomplete).toBe(1)
  })

  test('exactly at the threshold it is judged, and judged a miss', () => {
    // 60% of the goal is believable as a light day, and nowhere near the band.
    const report = buildCalorieReport(
      [day('2026-09-01', { calories: 2000 * INCOMPLETE_RATIO }, 2000)],
      [],
    )
    expect(report.days[0]?.status).toBe('offTarget')
    expect(report.incomplete).toBe(0)
  })

  test('is kept out of the averages', () => {
    // Two honest days at target, one unfinished. The average must read 2000,
    // not the 1633 that including the gap would produce.
    const report = buildCalorieReport(
      [
        day('2026-09-01', { calories: 2000 }, 2000),
        day('2026-09-02', { calories: 900 }, 2000),
        day('2026-09-03', { calories: 2000 }, 2000),
      ],
      [],
    )
    expect(report.onTarget).toBe(2)
    expect(report.avgEaten).toBe(2000)
  })

  test('a day logged as nothing at all is the common case', () => {
    const report = buildCalorieReport([day('2026-09-01', null, 2000)], [])
    expect(report.days[0]?.status).toBe('incomplete')
  })

  test('skipped by the averages, never by the counts', () => {
    // Excluded from the arithmetic but not from the page: a period whose days
    // quietly vanished would read better than it was.
    const report = buildCalorieReport(
      [day('2026-09-01', { calories: 2000 }, 2000), day('2026-09-02', { calories: 900 }, 2000)],
      [],
    )
    expect(report.avgEaten).toBe(2000)
    expect(report.days).toHaveLength(2)
    expect(report.incomplete).toBe(1)
  })
})

describe('weekBars', () => {
  const built = (summaries: Parameters<typeof buildCalorieReport>[0]) =>
    buildCalorieReport(summaries, []).weeks

  test('one bar per ISO week, in order', () => {
    // 14-20 September 2026 is week 38; the 21st opens week 39.
    const weeks = built([
      day('2026-09-14', { calories: 2000 }, 2000),
      day('2026-09-20', { calories: 2000 }, 2000),
      day('2026-09-21', { calories: 2000 }, 2000),
    ])
    expect(weeks.map((w) => w.label)).toEqual(['W38', 'W39'])
  })

  test('the bar is planned minus eaten, so a deficit points up', () => {
    // Sign named deliberately: 4000 planned against 4100 eaten is -100, an
    // overshoot, and it hangs below the axis.
    const weeks = built([
      day('2026-09-14', { calories: 2200 }, 2000),
      day('2026-09-15', { calories: 1900 }, 2000),
    ])
    expect(weeks[0]?.deficit).toBe(-100)
    expect(weeks[0]?.completeDays).toBe(2)
    expect(weeks[0]?.perDay).toBe(-50)
  })

  test('both sides drop the same days, so the difference is comparable', () => {
    // An incomplete day leaves neither its goal nor its intake in the sums; if
    // only its intake went, the deficit would grow by the whole missing goal.
    const weeks = built([
      day('2026-09-14', { calories: 1800 }, 2000),
      day('2026-09-15', { calories: 200 }, 2000),
    ])
    expect(weeks[0]?.deficit).toBe(200)
    expect(weeks[0]?.completeDays).toBe(1)
  })

  test('the per-day figure is what makes a short week comparable', () => {
    // Two days at -200 each and five days at -200 each are the same behaviour;
    // only the per-day series says so.
    const two = built([
      day('2026-09-14', { calories: 1800 }, 2000),
      day('2026-09-15', { calories: 1800 }, 2000),
    ])
    expect(two[0]?.deficit).toBe(400)
    expect(two[0]?.perDay).toBe(200)
  })

  test('over the week is red, under is green', () => {
    expect(built([day('2026-09-14', { calories: 2200 }, 2000)])[0]?.status).toBe('over')
    expect(built([day('2026-09-14', { calories: 1900 }, 2000)])[0]?.status).toBe('clean')
  })

  test('a week that came out exactly level is not an overshoot', () => {
    expect(built([day('2026-09-14', { calories: 2000 }, 2000)])[0]?.status).toBe('clean')
  })

  test('a week that is nothing but gaps has no per-day figure to divide', () => {
    const weeks = built([day('2026-09-14', null, 2000)])
    expect(weeks[0]).toMatchObject({ completeDays: 0, deficit: 0, perDay: 0, status: 'incomplete' })
  })

  test('a gap makes the week grey, whatever the balance says', () => {
    // The height is short by a missing day, so colouring it by that height would
    // assert something about a total known to be incomplete.
    const weeks = built([
      day('2026-09-14', { calories: 2600 }, 2000),
      day('2026-09-15', null, 2000),
    ])
    expect(weeks[0]?.status).toBe('incomplete')
    expect(weeks[0]?.deficit).toBe(-600)
  })

  test('weeks either side of New Year stay separate', () => {
    // 31 December 2026 is week 53 of 2026; 4 January 2027 is week 1 of 2027.
    // Keyed by number alone they would merge, or sort wrongly.
    const weeks = built([
      day('2026-12-31', { calories: 2000 }, 2000),
      day('2027-01-04', { calories: 2000 }, 2000),
    ])
    expect(weeks.map((w) => w.label)).toEqual(['W53', 'W1'])
  })
})

describe('the rendered PDF', () => {
  const decode = (b: Uint8Array) => new TextDecoder().decode(b)

  const range = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) =>
      day(`2026-09-${String(from + i).padStart(2, '0')}`, { calories: 2000 }, 2400),
    )

  test('carries the summary figures', () => {
    const pdf = decode(
      renderCalorieReportPdf(
        buildCalorieReport(
          [day('2026-09-01', { calories: 1800, protein: 150, carbs: 200, fats: 60 }, 2000)],
          [],
        ),
      ),
    )
    expect(pdf).toContain('Calorie report')
    expect(pdf).toContain('2026-09-01 - 2026-09-01')
    expect(pdf).toContain('1800 eaten / 2000 goal, over 1 complete day)')
    expect(pdf).toContain('(P 150   F 60   C 200)')
    for (const heading of ['(Total days)', '(On target)', '(Off target)', '(Incomplete data)']) {
      expect(pdf, heading).toContain(heading)
    }
  })

  test('says how many complete days the averages are over', () => {
    // An average that silently skipped a third of the period would be the most
    // misleading figure on the page.
    const pdf = decode(
      renderCalorieReportPdf(
        buildCalorieReport(
          [day('2026-09-01', { calories: 1900 }, 2000), day('2026-09-02', { calories: 900 }, 2000)],
          [],
        ),
      ),
    )
    // Singular, not "1 complete days".
    expect(pdf).toContain('over 1 complete day)')
  })

  test('drops the total balance, which measured an arbitrary span', () => {
    const pdf = decode(
      renderCalorieReportPdf(buildCalorieReport([day('2026-09-01', { calories: 1800 }, 2000)], [])),
    )
    expect(pdf).not.toContain('Total balance')
  })

  test('tints a row per status rather than marking it with a symbol', () => {
    const pdf = decode(
      renderCalorieReportPdf(
        buildCalorieReport(
          [
            day('2026-09-01', { calories: 1900 }, 2000),
            day('2026-09-02', { calories: 2600 }, 2000),
            day('2026-09-03', { calories: 900 }, 2000),
          ],
          [],
        ),
      ),
    )
    // Six fills: three pale row tints, and the same three hues saturated for the
    // pie and the bars. A pie of near-white slices would be unreadable, and a
    // row tint dark enough for a pie would swallow the text on it.
    const fills = new Set([...pdf.matchAll(/q ([\d.]+ [\d.]+ [\d.]+) rg/g)].map((m) => m[1]))
    expect(fills.size).toBe(6)

    // And no symbol is appended to a date any more.
    expect(pdf).toContain('(2026-09-01)')
    expect(pdf).not.toMatch(/\(2026-09-0\d [*?]\)/)
  })

  test('withholds the difference on a day it does not believe', () => {
    // -2400 is arithmetically right and editorially wrong: it is the deficit
    // the report just declined to count.
    const pdf = decode(
      renderCalorieReportPdf(buildCalorieReport([day('2026-09-01', null, 2400)], [])),
    )
    expect(pdf).toContain('(2400)')
    expect(pdf).not.toContain('(-2400)')
  })

  test('draws a pie of the three counts', () => {
    const pdf = decode(
      renderCalorieReportPdf(
        buildCalorieReport(
          [
            day('2026-09-01', { calories: 1900 }, 2000),
            day('2026-09-02', { calories: 2600 }, 2000),
            day('2026-09-03', { calories: 900 }, 2000),
          ],
          [],
        ),
      ),
    )
    // Curved paths, one per slice: `h f` closes a pie, `re f` fills a rectangle.
    expect(pdf.match(/h f/g)).toHaveLength(3)
    // Each cuts to the centre, which is what makes it a wedge and not a ring.
    const wedges = [...pdf.matchAll(/rg\n[\d.]+ [\d.]+ m [\d.]+ [\d.]+ l/g)]
    expect(wedges).toHaveLength(3)
  })

  test('a status with no days gets no slice', () => {
    // A zero-width wedge is invisible but still a path, and one that closes on
    // itself is the sort of thing a renderer may draw oddly.
    const pdf = decode(
      renderCalorieReportPdf(buildCalorieReport([day('2026-09-01', { calories: 1900 }, 2000)], [])),
    )
    expect(pdf.match(/h f/g)).toHaveLength(1)
    // One slice is the whole circle, and a circle must not be cut to the centre
    // or the seam shows.
    expect(pdf).not.toMatch(/rg\n[\d.]+ [\d.]+ m [\d.]+ [\d.]+ l/)
  })

  test('groups the days under calendar months', () => {
    const pdf = decode(
      renderCalorieReportPdf(
        buildCalorieReport(
          [
            day('2026-09-30', { calories: 1900 }, 2000),
            day('2026-10-01', { calories: 1900 }, 2000),
          ],
          [],
        ),
      ),
    )
    expect(pdf).toContain('(September 2026)')
    expect(pdf).toContain('(October 2026)')
  })

  test('nothing is drawn outside the page margins', () => {
    // The charts, the pie and the table all place themselves by arithmetic, and
    // a printer will cut off whatever strays. Cheap to check, invisible to
    // review.
    const long = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 3) + i * 86_400_000).toISOString().slice(0, 10)
      return day(d, { calories: i % 9 === 0 ? 0 : 2600 }, 2400)
    })
    const pdf = decode(renderCalorieReportPdf(buildCalorieReport(long, [])))
    const body = pdf.slice(pdf.indexOf('stream\n') + 7, pdf.indexOf('\nendstream'))

    const xs = [...body.matchAll(/(-?[\d.]+) (-?[\d.]+) Td/g)].map((m) => Number(m[1]))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(36)
    expect(Math.max(...xs)).toBeLessThanOrEqual(555)

    const rects = [...body.matchAll(/rg (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re f/g)]
    for (const r of rects) {
      const [x, y, w, h] = r.slice(1).map(Number) as [number, number, number, number]
      expect(x).toBeGreaterThanOrEqual(36)
      expect(x + w).toBeLessThanOrEqual(555)
      expect(y).toBeGreaterThanOrEqual(20)
      expect(y + h).toBeLessThanOrEqual(822)
    }
  })

  test('the legend names all three colours', () => {
    const pdf = decode(
      renderCalorieReportPdf(buildCalorieReport([day('2026-09-01', { calories: 1900 }, 2000)], [])),
    )
    expect(pdf).toContain('(on target)')
    expect(pdf).toContain('(off target)')
    expect(pdf).toContain('under 60% of it logged')
  })

  test('carries one row per day, with the target and the macros', () => {
    const pdf = decode(
      renderCalorieReportPdf(
        buildCalorieReport(
          [day('2026-09-01', { calories: 1900, protein: 151, carbs: 201, fats: 61 }, 2000)],
          [],
        ),
      ),
    )
    expect(pdf).toContain('(2026-09-01)')
    for (const value of ['(2000)', '(1900)', '(-100)', '(151)', '(61)', '(201)']) {
      expect(pdf, value).toContain(value)
    }
  })

  test('shows a dash where a day has no goal, rather than a zero', () => {
    const pdf = decode(
      renderCalorieReportPdf(buildCalorieReport([day('2026-09-01', { calories: 1900 }, null)], [])),
    )
    expect(pdf).toContain('(-)')
    expect(pdf).toContain('(2026-09-01)')
  })

  test('one short period is one page', () => {
    const pdf = decode(renderCalorieReportPdf(buildCalorieReport(range(20), [])))
    expect(pdf).toContain('/Count 1')
    expect(pdf).toContain('(Page 1 of 1)')
  })

  test('a long period paginates, and every page repeats the column header', () => {
    // Four months of days, which cannot fit on one page at any sane leading.
    const long = Array.from({ length: 120 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 4, 1) + i * 86_400_000).toISOString().slice(0, 10)
      return day(d, { calories: 2000 }, 2400)
    })
    const pdf = decode(renderCalorieReportPdf(buildCalorieReport(long, [])))
    const pages = Number(/\/Count (\d+)/.exec(pdf)?.[1])
    expect(pages).toBeGreaterThan(1)
    // One "Date" heading per page, and the count agrees with the page tree.
    expect(pdf.match(/\(Date\)/g)).toHaveLength(pages)
    expect(pdf).toContain(`(Page 1 of ${pages})`)
  })

  test('a period with no days still produces a readable page', () => {
    // Pressing the button before logging anything must not throw.
    const pdf = decode(renderCalorieReportPdf(buildCalorieReport([], [])))
    expect(pdf).toContain('/Count 1')
    expect(pdf).toContain('Calorie report')
  })
})
