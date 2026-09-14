import { describe, expect, test } from 'bun:test'
import {
  type PlannedSession,
  type PlannedStep,
  type TargetSettings,
  classifyRide,
  computeDay,
  computeDays,
  rideCoefficient,
  scoreRide,
} from '../src/lib/trainingLoad.ts'
import { DEFAULT_TUNING } from '../shared/goalTuning.ts'

// The numbers are a stored, user-editable tuning now — see
// tests/goalTuning.test.ts for the dials themselves. What these assert is that
// the DEFAULTS behave as specified, which is what an unconfigured user gets.
const COEFFICIENTS = DEFAULT_TUNING
const DEFINING_BLOCK_SECONDS = DEFAULT_TUNING.definingBlockSeconds
const STRENGTH_KCAL = DEFAULT_TUNING.strengthKcal

// Pure unit tests — no database, no HTTP, no fixture. The intervals.icu wire
// shape is normalised into PlannedSession by src/integrations/intervals.ts and
// tested there against the recorded response; what is under test here is the
// arithmetic on top of it.

const SETTINGS: TargetSettings = { baseCalories: 1450, proteinG: 140, fatG: 60 }

const step = (minutes: number, intensity: number): PlannedStep => ({
  seconds: minutes * 60,
  intensity,
})

const ride = (over: Partial<PlannedSession> = {}): PlannedSession => ({
  date: '2026-09-13',
  name: 'Ride',
  kind: 'ride',
  minutes: 60,
  steps: [],
  ...over,
})

describe('classifyRide', () => {
  test('an all-endurance ride is Z2', () => {
    expect(classifyRide([step(120, 0.65)])).toBe('z2')
  })

  test('a sweet-spot session is not Z2, even though its easy time is longer', () => {
    // The case that rules out BOTH naive rules. Warm-up, recoveries and
    // cool-down total 40 minutes against 36 minutes of work, so "the band with
    // the most total time" picks Z2; and the 20-minute warm-up is the longest
    // single step, so "the longest step" picks Z2 too. Only "the hardest band
    // holding at least ten minutes" gets it right.
    const steps = [
      step(20, 0.55),
      step(12, 0.92),
      step(5, 0.55),
      step(12, 0.92),
      step(5, 0.55),
      step(12, 0.92),
      step(10, 0.55),
    ]
    const easy = steps.filter((s) => s.intensity < 0.8).reduce((n, s) => n + s.seconds, 0)
    const work = steps.filter((s) => s.intensity >= 0.8).reduce((n, s) => n + s.seconds, 0)
    expect(easy).toBeGreaterThan(work)

    expect(classifyRide(steps)).toBe('threshold')
  })

  test('5×3 min above threshold is VO2max', () => {
    const steps = [step(15, 0.55), ...Array.from({ length: 5 }, () => step(3, 1.15)), step(10, 0.5)]
    expect(classifyRide(steps)).toBe('vo2max')
  })

  test('one short surge does not promote a long endurance ride', () => {
    // 2 minutes is below the defining block, so the three hours decide.
    expect(classifyRide([step(90, 0.65), step(2, 1.2), step(88, 0.65)])).toBe('z2')
  })

  test('tempo counts as threshold, the nearer of its two neighbours', () => {
    expect(classifyRide([step(60, 0.85)])).toBe('threshold')
  })

  test('the band boundaries are where they are documented', () => {
    expect(classifyRide([step(20, 0.8)])).toBe('z2')
    expect(classifyRide([step(20, 0.81)])).toBe('threshold')
    expect(classifyRide([step(20, 1.05)])).toBe('threshold')
    expect(classifyRide([step(20, 1.06)])).toBe('vo2max')
  })

  test('exactly the defining block counts, a second less does not', () => {
    const short = DEFINING_BLOCK_SECONDS / 60 - 1 / 60
    expect(
      classifyRide([step(60, 0.65), { seconds: DEFINING_BLOCK_SECONDS, intensity: 1.2 }]),
    ).toBe('vo2max')
    expect(classifyRide([step(60, 0.65), step(short, 1.2)])).toBe('z2')
  })

  test('with no block long enough, the largest share decides', () => {
    // A 12-minute opener: nothing reaches ten minutes in one band.
    expect(classifyRide([step(4, 0.6), step(8, 1.2)])).toBe('vo2max')
    expect(classifyRide([step(8, 0.6), step(4, 1.2)])).toBe('z2')
  })

  test('no steps at all is unknown, and zero-length steps do not count', () => {
    expect(classifyRide([])).toBe('unknown')
    expect(classifyRide([{ seconds: 0, intensity: 1.2 }])).toBe('unknown')
  })
})

describe('rideCoefficient', () => {
  test('the Z2 bands are closed, including the gaps the source table left', () => {
    expect(rideCoefficient('z2', 60)).toBe(COEFFICIENTS.z2Short)
    expect(rideCoefficient('z2', 75)).toBe(COEFFICIENTS.z2Short)
    // 75–90 minutes had no row in the original table.
    expect(rideCoefficient('z2', 80)).toBe(COEFFICIENTS.z2Medium)
    expect(rideCoefficient('z2', 90)).toBe(COEFFICIENTS.z2Medium)
    expect(rideCoefficient('z2', 150)).toBe(COEFFICIENTS.z2Medium)
    expect(rideCoefficient('z2', 151)).toBe(COEFFICIENTS.z2Long)
    // Past five hours had no row either.
    expect(rideCoefficient('z2', 360)).toBe(COEFFICIENTS.z2Long)
  })

  test('intensity beats duration for the harder sessions', () => {
    expect(rideCoefficient('threshold', 45)).toBe(COEFFICIENTS.threshold)
    expect(rideCoefficient('threshold', 300)).toBe(COEFFICIENTS.threshold)
    expect(rideCoefficient('vo2max', 45)).toBe(COEFFICIENTS.vo2max)
  })

  test('an unclassifiable ride takes the most conservative number', () => {
    expect(rideCoefficient('unknown', 300)).toBe(COEFFICIENTS.z2Short)
  })
})

describe('scoreRide', () => {
  test('multiplies planned kilojoules by the coefficient', () => {
    const scored = scoreRide(ride({ kj: 1678, minutes: 75, steps: [step(40, 0.92)] }))
    expect(scored.kind).toBe('threshold')
    expect(scored.coeff).toBe(0.9)
    expect(scored.kcal).toBe(Math.round(1678 * 0.9))
  })

  test('a ride with no planned work stays in the breakdown, scoring zero', () => {
    // Dropping it would hide the reason the day looks light.
    const scored = scoreRide(ride({ name: 'Утренний выезд', minutes: 120 }))
    expect(scored.kj).toBe(0)
    expect(scored.kcal).toBe(0)
    expect(scored.kind).toBe('unknown')
    expect(scored.name).toBe('Утренний выезд')
  })
})

describe('computeDay', () => {
  test('a rest day is the base alone', () => {
    const day = computeDay('2026-09-13', [], SETTINGS)
    expect(day.dayType).toBe('rest')
    expect(day.calories).toBe(1450)
    expect(day.protein).toBe(140)
    expect(day.fat).toBe(60)
    // 1450 − 140×4 − 60×9 = 350 kcal of carbohydrate.
    expect(day.carbs).toBe(88)
    expect(day.breakdown).toEqual({ base: 1450, strength: 0, rides: [] })
  })

  test('a strength session adds a flat bonus and makes it a training day', () => {
    const day = computeDay(
      '2026-09-13',
      [{ date: '2026-09-13', name: 'Gym', kind: 'strength', minutes: 60, steps: [] }],
      SETTINGS,
    )
    expect(day.dayType).toBe('training')
    expect(day.calories).toBe(1450 + STRENGTH_KCAL)
    expect(day.breakdown.strength).toBe(STRENGTH_KCAL)
  })

  test('two strength sessions count twice', () => {
    const gym = {
      date: '2026-09-13',
      name: 'Gym',
      kind: 'strength' as const,
      minutes: 45,
      steps: [],
    }
    expect(computeDay('2026-09-13', [gym, gym], SETTINGS).breakdown.strength).toBe(
      STRENGTH_KCAL * 2,
    )
  })

  test('base plus strength plus rides, as the goals screen spells it out', () => {
    const day = computeDay(
      '2026-09-12',
      [
        { date: '2026-09-12', name: 'Gym', kind: 'strength', minutes: 45, steps: [] },
        ride({
          date: '2026-09-12',
          name: 'Long Z2',
          kj: 1678,
          minutes: 180,
          steps: [step(180, 0.65)],
        }),
      ],
      SETTINGS,
    )
    expect(day.breakdown.base).toBe(1450)
    expect(day.breakdown.strength).toBe(250)
    expect(day.breakdown.rides[0]?.kcal).toBe(Math.round(1678 * 0.9))
    expect(day.calories).toBe(1450 + 250 + Math.round(1678 * 0.9))
  })

  test('a ride with no plan still marks the day as training', () => {
    const day = computeDay('2026-09-13', [ride({ minutes: 90 })], SETTINGS)
    expect(day.dayType).toBe('training')
    expect(day.calories).toBe(1450)
    expect(day.breakdown.rides).toHaveLength(1)
  })

  test('an event that is neither ride nor strength changes nothing', () => {
    const note: PlannedSession = {
      date: '2026-09-13',
      name: 'Rest week',
      kind: 'other',
      minutes: 0,
      steps: [],
    }
    const day = computeDay('2026-09-13', [note], SETTINGS)
    expect(day.dayType).toBe('rest')
    expect(day.calories).toBe(1450)
    expect(day.breakdown.rides).toEqual([])
  })

  test('carbohydrate is floored at zero and says so', () => {
    // 200 g protein and 120 g fat is 1880 kcal against a 1200 kcal day.
    const day = computeDay('2026-09-13', [], { baseCalories: 1200, proteinG: 200, fatG: 120 })
    expect(day.carbs).toBe(0)
    expect(day.breakdown.carbsClamped).toBe(true)
  })

  test('an exact fit is not a clamp', () => {
    // 140×4 + 60×9 = 1100.
    const day = computeDay('2026-09-13', [], { baseCalories: 1100, proteinG: 140, fatG: 60 })
    expect(day.carbs).toBe(0)
    expect(day.breakdown.carbsClamped).toBeUndefined()
  })

  test('a big ride day scales carbohydrate, not protein or fat', () => {
    const day = computeDay(
      '2026-09-13',
      [ride({ kj: 2000, minutes: 180, steps: [step(180, 0.65)] })],
      SETTINGS,
    )
    expect(day.protein).toBe(140)
    expect(day.fat).toBe(60)
    expect(day.calories).toBe(1450 + 1800)
    expect(day.carbs).toBe(Math.round((3250 - 560 - 540) / 4))
  })
})

describe('computeDays', () => {
  test('produces a day for every date asked for, planned or not', () => {
    const days = computeDays(
      ['2026-09-11', '2026-09-12', '2026-09-13'],
      [ride({ date: '2026-09-12', kj: 1000, minutes: 60, steps: [step(60, 0.65)] })],
      SETTINGS,
    )
    expect(days.map((d) => d.date)).toEqual(['2026-09-11', '2026-09-12', '2026-09-13'])
    expect(days.map((d) => d.dayType)).toEqual(['rest', 'training', 'rest'])
  })

  test('ignores sessions outside the requested dates', () => {
    const days = computeDays(
      ['2026-09-13'],
      [ride({ date: '2026-01-01', kj: 5000, minutes: 300, steps: [step(300, 0.65)] })],
      SETTINGS,
    )
    expect(days).toHaveLength(1)
    expect(days[0]?.calories).toBe(1450)
  })
})
