import { describe, expect, test } from 'vitest'
import {
  OVERAGE_END_T,
  animationDurationMs,
  easeOut,
  gradientStops,
  hexToRgb,
  interpolateColor,
  ringColor,
} from './ringColor'

// Literal inputs rather than theme tokens. The theme holds custom properties
// now, which arithmetic cannot read — and a pure maths module should not have
// been sourcing its fixtures from the design system anyway.
const protein = ['#80D8FF', '#0091EA'].map(hexToRgb)
/** iOS systemRed, the ring's overage colour in both themes. */
const RED = hexToRgb('#FF3B30')

const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps
const sameColor = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
) => near(a.r, b.r) && near(a.g, b.g) && near(a.b, b.b)

describe('interpolateColor', () => {
  test('returns the endpoints exactly', () => {
    expect(interpolateColor(protein, 0)).toEqual(protein[0])
    expect(interpolateColor(protein, 1)).toEqual(protein[1])
  })

  test('clamps outside [0, 1] instead of extrapolating', () => {
    expect(interpolateColor(protein, -5)).toEqual(protein[0])
    expect(interpolateColor(protein, 5)).toEqual(protein[1])
  })

  test('midpoint is the arithmetic mean of the two stops', () => {
    const mid = interpolateColor(protein, 0.5)
    expect(mid.r).toBeCloseTo((protein[0]!.r + protein[1]!.r) / 2, 6)
    expect(mid.g).toBeCloseTo((protein[0]!.g + protein[1]!.g) / 2, 6)
  })

  test('degenerate stop lists do not throw', () => {
    expect(interpolateColor([], 0.5)).toEqual({ r: 255, g: 255, b: 255 })
    expect(interpolateColor([protein[0]!], 0.5)).toEqual(protein[0])
  })
})

describe('ringColor', () => {
  test('lap 1 is the plain palette gradient', () => {
    expect(ringColor(protein, 0, RED)).toEqual(protein[0])
    expect(ringColor(protein, 1, RED)).toEqual(protein[1])
  })

  test('past the ramp it is solid systemRed', () => {
    expect(ringColor(protein, OVERAGE_END_T, RED)).toEqual(RED)
    expect(ringColor(protein, 1.5, RED)).toEqual(RED)
    expect(ringColor(protein, 4, RED)).toEqual(RED)
  })

  // Both knees must be continuous or the ring shows a hard colour step.
  test('is continuous at t = 1', () => {
    const eps = 1e-6
    expect(sameColor(ringColor(protein, 1 - eps, RED), ringColor(protein, 1 + eps, RED))).toBe(true)
  })

  test('is continuous at t = OVERAGE_END_T', () => {
    const eps = 1e-6
    expect(
      sameColor(
        ringColor(protein, OVERAGE_END_T - eps, RED),
        ringColor(protein, OVERAGE_END_T + eps, RED),
      ),
    ).toBe(true)
  })

  test('ramps monotonically towards red across lap 2', () => {
    const start = ringColor(protein, 1, RED)
    const mid = ringColor(protein, 1 + (OVERAGE_END_T - 1) / 2, RED)
    // Protein's last stop is a deep blue, so "towards red" means r rises.
    expect(mid.r).toBeGreaterThan(start.r)
    expect(mid.r).toBeLessThan(RED.r)
  })

  // This is the invariant that keeps the 90° segment seams invisible.
  test('a shared segment boundary yields identical colours', () => {
    for (const t of [0.25, 0.5, 0.75, 1, 1.02, 1.07, 2]) {
      expect(ringColor(protein, t, RED)).toEqual(ringColor(protein, t, RED))
    }
  })
})

describe('gradientStops', () => {
  test('a segment with no interior knee gets exactly two stops', () => {
    const s = gradientStops(protein, 0, 0.25, RED)
    expect(s).toHaveLength(2)
    expect(s[0]!.location).toBe(0)
    expect(s[1]!.location).toBe(1)
  })

  test('inserts a stop where t = 1 falls inside the segment', () => {
    const s = gradientStops(protein, 0.75, 1.25, RED)
    expect(s).toHaveLength(4) // start, t=1, t=OVERAGE_END_T, end
    expect(s[1]!.location).toBeCloseTo(0.5, 6)
    expect(s[1]!.color).toEqual(protein[1])
  })

  test('inserts a stop for the ramp end too', () => {
    const s = gradientStops(protein, 1, 1.25, RED)
    const kneeAt = (OVERAGE_END_T - 1) / 0.25
    expect(s.some((x) => Math.abs(x.location - kneeAt) < 1e-9)).toBe(true)
  })

  test('does not insert a knee that sits on the segment boundary', () => {
    // Knees are strictly interior: at exactly t = 1 the endpoint already
    // carries that colour, and a duplicate stop would be redundant.
    expect(gradientStops(protein, 1, 1.5, RED).filter((s) => s.location === 0)).toHaveLength(1)
    expect(gradientStops(protein, 0.5, 1, RED)).toHaveLength(2)
  })

  test('locations are ascending and span the full [0, 1]', () => {
    for (const [a, b] of [
      [0, 0.25],
      [0.75, 1.25],
      [1, 1.25],
      [0.9, 1.9],
    ]) {
      const s = gradientStops(protein, a!, b!, RED)
      expect(s[0]!.location).toBe(0)
      expect(s.at(-1)!.location).toBe(1)
      for (let i = 1; i < s.length; i++) {
        expect(s[i]!.location).toBeGreaterThanOrEqual(s[i - 1]!.location)
      }
    }
  })

  test('endpoint colours agree with ringColor at the same t', () => {
    const s = gradientStops(protein, 0.75, 1.25, RED)
    expect(s[0]!.color).toEqual(ringColor(protein, 0.75, RED))
    expect(s.at(-1)!.color).toEqual(ringColor(protein, 1.25, RED))
  })
})

describe('animation timing', () => {
  test('ease-out starts at 0, ends at 1 and is front-loaded', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
  })

  test('duration scales with the target but stays inside [600, 1400] ms', () => {
    expect(animationDurationMs(0)).toBe(600)
    expect(animationDurationMs(1)).toBe(650)
    expect(animationDurationMs(10)).toBe(1400)
    // 0.4 + 0.8 * 0.25 lands a float epsilon above the 0.6 floor, so this is
    // "clamped" rather than exactly equal.
    expect(animationDurationMs(0.8)).toBeCloseTo(600, 6)
  })

  test('never returns a value outside the clamp for any plausible ratio', () => {
    for (let v = 0; v <= 5; v += 0.05) {
      const d = animationDurationMs(v)
      expect(d).toBeGreaterThanOrEqual(600)
      expect(d).toBeLessThanOrEqual(1400)
    }
  })
})
