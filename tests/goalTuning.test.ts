import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TUNING,
  type GoalTuning,
  TUNING_FIELDS,
  bandOf,
  mergeTuning,
  rideCoefficient,
  tuningOrderError,
  tuningOverrides,
} from '../shared/goalTuning.ts'

// The dials are stored as overrides and read back merged, so the interesting
// cases are all about what happens to a stored value that no longer makes
// sense — a dial removed, a dial added, a number out of range.

const tuned = (over: Partial<GoalTuning>): GoalTuning => ({ ...DEFAULT_TUNING, ...over })

describe('mergeTuning', () => {
  test('nothing stored means every default', () => {
    expect(mergeTuning(null)).toEqual(DEFAULT_TUNING)
    expect(mergeTuning({})).toEqual(DEFAULT_TUNING)
    expect(mergeTuning(undefined)).toEqual(DEFAULT_TUNING)
  })

  test('overlays only what is stored', () => {
    const merged = mergeTuning({ vo2max: 1.05 })
    expect(merged.vo2max).toBe(1.05)
    expect(merged.z2Short).toBe(DEFAULT_TUNING.z2Short)
  })

  test('ignores a key that is no longer a dial', () => {
    // A row written before a dial was renamed or removed must keep working.
    expect(mergeTuning({ z2Short: 0.75, someOldDial: 42 })).toEqual(tuned({ z2Short: 0.75 }))
  })

  test('ignores anything that is not a finite number', () => {
    expect(mergeTuning({ z2Short: '0.75' })).toEqual(DEFAULT_TUNING)
    expect(mergeTuning({ z2Short: Number.NaN })).toEqual(DEFAULT_TUNING)
    expect(mergeTuning({ z2Short: null })).toEqual(DEFAULT_TUNING)
  })

  test('falls back to the default rather than computing with an absurd value', () => {
    // The route rejects these on the way in; this guards a row that was already
    // stored or edited by hand.
    expect(mergeTuning({ z2Short: 50 }).z2Short).toBe(DEFAULT_TUNING.z2Short)
    expect(mergeTuning({ strengthKcal: -100 }).strengthKcal).toBe(DEFAULT_TUNING.strengthKcal)
  })

  test('repairs a band whose edges are the wrong way round', () => {
    // Short above long leaves no duration in the middle band at all.
    const merged = mergeTuning({ z2ShortMaxMinutes: 200, z2LongMinMinutes: 100 })
    expect(merged.z2ShortMaxMinutes).toBe(DEFAULT_TUNING.z2ShortMaxMinutes)
    expect(merged.z2LongMinMinutes).toBe(DEFAULT_TUNING.z2LongMinMinutes)
  })

  test('repairs inverted zone edges', () => {
    const merged = mergeTuning({ z2MaxIntensity: 0.95, thresholdMaxIntensity: 0.6 })
    expect(merged.z2MaxIntensity).toBe(DEFAULT_TUNING.z2MaxIntensity)
    expect(merged.thresholdMaxIntensity).toBe(DEFAULT_TUNING.thresholdMaxIntensity)
  })

  test('survives a stored value that is not an object at all', () => {
    expect(mergeTuning('nope')).toEqual(DEFAULT_TUNING)
    expect(mergeTuning(7)).toEqual(DEFAULT_TUNING)
  })
})

describe('tuningOverrides', () => {
  test('a tuning at its defaults stores nothing', () => {
    expect(tuningOverrides(DEFAULT_TUNING)).toEqual({})
  })

  test('keeps only what differs', () => {
    expect(tuningOverrides(tuned({ vo2max: 1, strengthKcal: 300 }))).toEqual({
      vo2max: 1,
      strengthKcal: 300,
    })
  })

  test('round-trips through merge', () => {
    const wanted = tuned({ z2Long: 0.95, definingBlockSeconds: 300 })
    expect(mergeTuning(tuningOverrides(wanted))).toEqual(wanted)
  })
})

describe('tuningOrderError', () => {
  test('accepts the defaults', () => {
    expect(tuningOrderError(DEFAULT_TUNING)).toBeNull()
  })

  test('names the pair that is inverted', () => {
    expect(tuningOrderError({ z2ShortMaxMinutes: 200, z2LongMinMinutes: 100 })).toContain(
      'Короткий до',
    )
    expect(tuningOrderError({ z2MaxIntensity: 0.95, thresholdMaxIntensity: 0.6 })).toContain(
      'Z2 до',
    )
  })

  test('equal edges are fine — a band may be a single point', () => {
    expect(tuningOrderError({ z2ShortMaxMinutes: 100, z2LongMinMinutes: 100 })).toBeNull()
  })
})

describe('the dials actually drive the lookups', () => {
  test('a changed coefficient changes the multiplier', () => {
    expect(rideCoefficient('vo2max', 60, tuned({ vo2max: 1.1 }))).toBe(1.1)
  })

  test('changed Z2 edges move which band a duration falls in', () => {
    const wide = tuned({ z2ShortMaxMinutes: 120, z2LongMinMinutes: 300 })
    expect(rideCoefficient('z2', 100, DEFAULT_TUNING)).toBe(DEFAULT_TUNING.z2Medium)
    expect(rideCoefficient('z2', 100, wide)).toBe(wide.z2Short)
    expect(rideCoefficient('z2', 250, wide)).toBe(wide.z2Medium)
  })

  test('changed zone edges move which band an intensity falls in', () => {
    expect(bandOf(0.85, DEFAULT_TUNING)).toBe('threshold')
    expect(bandOf(0.85, tuned({ z2MaxIntensity: 0.9 }))).toBe('z2')
    expect(bandOf(1.2, tuned({ thresholdMaxIntensity: 1.5 }))).toBe('threshold')
  })

  test('an unreadable plan takes the unknown multiplier, whatever it is set to', () => {
    const t = tuned({ unknown: 0.5 })
    expect(rideCoefficient('unknown', 120, t)).toBe(0.5)
    expect(rideCoefficient('needs_ftp', 120, t)).toBe(0.5)
  })

  test('called with no tuning, the defaults apply', () => {
    expect(rideCoefficient('vo2max', 60)).toBe(DEFAULT_TUNING.vo2max)
    expect(bandOf(0.85)).toBe('threshold')
  })
})

describe('the field table', () => {
  test('describes every dial, so none is uneditable or unvalidated', () => {
    // The form and the route's schema are both built from this list; a dial
    // missing from it is one the screen cannot show and the server drops.
    expect(TUNING_FIELDS.map((f) => f.key).sort()).toEqual(
      (Object.keys(DEFAULT_TUNING) as Array<keyof GoalTuning>).sort(),
    )
  })

  test('every default sits inside its own bounds', () => {
    for (const field of TUNING_FIELDS) {
      const value = DEFAULT_TUNING[field.key]
      expect(value, field.key).toBeGreaterThanOrEqual(field.min)
      expect(value, field.key).toBeLessThanOrEqual(field.max)
    }
  })

  test('no key appears twice', () => {
    expect(new Set(TUNING_FIELDS.map((f) => f.key)).size).toBe(TUNING_FIELDS.length)
  })
})
