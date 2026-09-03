// Colour maths for MacroRing, split out from the component so it can be unit
// tested. Direct port of the private helpers in CalTracker/MacroRing.swift.

import { overage } from '@/theme/tokens'

/** The overage ramp completes 25° into lap 2 — MacroRing.swift:231. */
export const OVERAGE_END_T = 1 + 25 / 360

export type Rgb = { r: number; g: number; b: number }

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '')
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  }
}

export function rgbToCss({ r, g, b }: Rgb): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
}

/**
 * Linear sRGB interpolation across N stops at t ∈ [0, 1].
 *
 * Two segments that share a boundary call this with the same t and therefore
 * get bit-identical colours — that is what keeps the seam between the ring's
 * 90° segments invisible.
 */
export function interpolateColor(stops: Rgb[], t: number): Rgb {
  if (stops.length === 0) return { r: 255, g: 255, b: 255 }
  if (stops.length === 1) return stops[0]!

  const clamped = Math.max(0, Math.min(1, t))
  const scaled = clamped * (stops.length - 1)
  const lower = Math.floor(scaled)
  const upper = Math.min(lower + 1, stops.length - 1)
  const frac = scaled - lower
  if (lower === upper) return stops[lower]!

  const lo = stops[lower]!
  const hi = stops[upper]!
  return {
    r: lo.r + (hi.r - lo.r) * frac,
    g: lo.g + (hi.g - lo.g) * frac,
    b: lo.b + (hi.b - lo.b) * frac,
  }
}

/**
 * Multi-lap ramp. Lap 1 is the palette gradient; the first 25° of lap 2 fades
 * into the warning colour; anything past that stays solid warning. Monotonic
 * and continuous at both knees (t = 1 and t = OVERAGE_END_T), which is what
 * lets adjacent segments meet without a visible seam.
 */
export function ringColor(stops: Rgb[], t: number): Rgb {
  if (t <= 1) return interpolateColor(stops, t)
  if (t >= OVERAGE_END_T) return hexToRgb(overage)

  const last = stops[stops.length - 1] ?? { r: 255, g: 255, b: 255 }
  const local = (t - 1) / (OVERAGE_END_T - 1)
  return interpolateColor([last, hexToRgb(overage)], local)
}

export type GradientStop = { color: Rgb; location: number }

/**
 * Piecewise-linear stop list for one ≤90° segment.
 *
 * ringColor has knees at t = 1 and t = OVERAGE_END_T. A plain two-stop
 * gradient would smear a knee across the segment's whole arc whenever one
 * falls inside it, so an explicit stop is inserted at each interior knee.
 */
export function gradientStops(stops: Rgb[], startT: number, endT: number): GradientStop[] {
  const out: GradientStop[] = [{ color: ringColor(stops, startT), location: 0 }]
  for (const knee of [1, OVERAGE_END_T]) {
    if (knee > startT && knee < endT) {
      out.push({ color: ringColor(stops, knee), location: (knee - startT) / (endT - startT) })
    }
  }
  out.push({ color: ringColor(stops, endT), location: 1 })
  return out
}

/** Cubic ease-out, matching MacroRing.swift:56. */
export function easeOut(t: number): number {
  return 1 - (1 - t) ** 3
}

/**
 * Animation length in ms. Longer rings take longer to fill, clamped to
 * [0.6s, 1.4s] — MacroRing.swift:47.
 */
export function animationDurationMs(target: number): number {
  return Math.max(0.6, Math.min(1.4, 0.4 + target * 0.25)) * 1000
}
