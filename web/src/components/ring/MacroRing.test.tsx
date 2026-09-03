import { palette, surface } from '@/theme/tokens'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MacroRing } from './MacroRing'
import { OVERAGE_END_T } from './ringColor'

// jsdom has no canvas backend, so the 2D context is replaced with a recorder.
// These assertions cover the parts of the port most likely to be wrong: the
// ≤90° segmentation, the head-before-arc draw order that produces the spiral
// shadow, and the conic-gradient stop scaling (SwiftUI spreads stops across
// the segment's arc, canvas spreads them across the whole turn).

type Call = { op: string; args: unknown[] }

let calls: Call[] = []
let gradientStops: Array<{ offset: number; color: string }> = []

function fakeContext(): CanvasRenderingContext2D {
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args })
    }
  const ctx = {
    canvas: {},
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    save: record('save'),
    restore: record('restore'),
    createConicGradient: (startAngle: number, x: number, y: number) => {
      calls.push({ op: 'createConicGradient', args: [startAngle, x, y] })
      return {
        addColorStop: (offset: number, color: string) => {
          gradientStops.push({ offset, color })
          calls.push({ op: 'addColorStop', args: [offset, color] })
        },
      }
    },
  }
  return ctx as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  calls = []
  gradientStops = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => fakeContext() as unknown as RenderingContext,
  )
  // Reduced motion makes the draw synchronous and deterministic — one frame at
  // the final value instead of a rAF ramp.
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal('devicePixelRatio', 2)
})

/** Every stroked arc except the background track, in draw order. */
function arcs() {
  const out: Array<{ startAngle: number; endAngle: number; index: number }> = []
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!
    if (c.op !== 'arc') continue
    const [, , , startAngle, endAngle] = c.args as number[]
    // The track and the head are full circles; segments are partial.
    if (Math.abs((endAngle ?? 0) - (startAngle ?? 0) - Math.PI * 2) < 1e-9) continue
    out.push({ startAngle: startAngle!, endAngle: endAngle!, index: i })
  }
  return out
}

const deg = (rad: number) => (rad * 180) / Math.PI + 90

describe('MacroRing drawing', () => {
  test('always strokes the background track first', () => {
    render(<MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />)
    const firstArc = calls.findIndex((c) => c.op === 'arc')
    const [, , radius, start, end] = calls[firstArc]!.args as number[]
    expect(end! - start!).toBeCloseTo(Math.PI * 2, 9)
    // radius = (size - strokeWidth) / 2
    expect(radius).toBeCloseTo(45, 9)
    expect(calls.some((c) => c.op === 'stroke')).toBe(true)
  })

  test('a quarter lap is a single 90° segment starting at twelve o clock', () => {
    render(<MacroRing value={0.25} stops={palette.protein} size={100} strokeWidth={10} />)
    const a = arcs()
    expect(a).toHaveLength(1)
    expect(deg(a[0]!.startAngle)).toBeCloseTo(0, 6)
    expect(deg(a[0]!.endAngle)).toBeCloseTo(90, 6)
  })

  test('half a lap is two 90° segments, not one 180° sweep', () => {
    render(<MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />)
    const a = arcs()
    expect(a).toHaveLength(2)
    expect(a.map((x) => Math.round(deg(x.startAngle)))).toEqual([0, 90])
    expect(Math.round(deg(a.at(-1)!.endAngle))).toBe(180)
  })

  test('a partial trailing segment keeps its exact end angle', () => {
    render(<MacroRing value={0.3} stops={palette.protein} size={100} strokeWidth={10} />)
    const a = arcs()
    expect(a).toHaveLength(2)
    expect(deg(a[0]!.endAngle)).toBeCloseTo(90, 6)
    expect(deg(a[1]!.endAngle)).toBeCloseTo(108, 6) // 0.3 * 360
  })

  test('a full lap is split into four 90° segments', () => {
    render(<MacroRing value={1} stops={palette.protein} size={100} strokeWidth={10} />)
    const a = arcs()
    expect(a).toHaveLength(4)
    expect(a.map((x) => Math.round(deg(x.startAngle)))).toEqual([0, 90, 180, 270])
    expect(Math.round(deg(a.at(-1)!.endAngle))).toBe(360)
  })

  test('overage adds a fifth partial segment on lap two', () => {
    render(<MacroRing value={1.15} stops={palette.fat} size={100} strokeWidth={10} />)
    const a = arcs()
    expect(a).toHaveLength(5)
    expect(deg(a[4]!.endAngle)).toBeCloseTo(1.15 * 360, 4)
  })

  test('adjacent segments share their boundary angle exactly, leaving no seam', () => {
    render(<MacroRing value={2.3} stops={palette.carbs} size={100} strokeWidth={10} />)
    const a = arcs()
    for (let i = 1; i < a.length; i++) {
      expect(a[i]!.startAngle).toBeCloseTo(a[i - 1]!.endAngle, 12)
    }
  })

  // The round cap of the last segment hides the head circle; only its shadow
  // escapes onto the lap below. Draw the head after its arc and the effect
  // inverts into an ugly blob.
  test('the head is filled before the final segment is stroked', () => {
    render(<MacroRing value={1.5} stops={palette.protein} size={100} strokeWidth={10} />)
    const lastFill = calls.map((c) => c.op).lastIndexOf('fill')
    const lastStroke = calls.map((c) => c.op).lastIndexOf('stroke')
    expect(lastFill).toBeLessThan(lastStroke)
  })

  test('exactly one head is drawn, with two stacked shadow passes', () => {
    render(<MacroRing value={2.5} stops={palette.protein} size={100} strokeWidth={10} />)
    expect(calls.filter((c) => c.op === 'save')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(2)
  })

  // SwiftUI spreads gradient stops across the segment's own arc; canvas
  // spreads them across the full turn. Missing the rescale makes the gradient
  // finish within the first few degrees of each segment.
  test('conic stops are scaled into the segment share of a full turn', () => {
    render(<MacroRing value={0.25} stops={palette.protein} size={100} strokeWidth={10} />)
    const scaled = gradientStops.filter((s) => s.offset < 1).map((s) => s.offset)
    // A single 90° segment occupies a quarter turn, so no interior stop may
    // sit beyond 0.25.
    expect(Math.max(...scaled)).toBeLessThanOrEqual(0.25 + 1e-9)
    expect(gradientStops.some((s) => s.offset === 1)).toBe(true)
  })

  test('each segment gets its own gradient anchored at its start angle', () => {
    render(<MacroRing value={1} stops={palette.protein} size={100} strokeWidth={10} />)
    const grads = calls.filter((c) => c.op === 'createConicGradient')
    expect(grads).toHaveLength(4)
    expect(deg((grads[0]!.args as number[])[0]!)).toBeCloseTo(0, 6)
    expect(deg((grads[1]!.args as number[])[0]!)).toBeCloseTo(90, 6)
  })

  test('the overage knee turns the head red once the ramp completes', () => {
    render(<MacroRing value={OVERAGE_END_T} stops={palette.protein} size={100} strokeWidth={10} />)
    // The head takes ringColor at the tip, which past the ramp is systemRed.
    const headFill = gradientStops.at(-1)?.color
    expect(headFill).toBe('rgb(255, 59, 48)')
  })

  test('zero draws the track and nothing else', () => {
    render(<MacroRing value={0} stops={palette.protein} size={100} strokeWidth={10} />)
    expect(arcs()).toHaveLength(0)
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(0)
  })

  test('dimmed renders the track only, whatever the value', () => {
    render(<MacroRing value={0.8} stops={palette.protein} size={100} strokeWidth={10} dimmed />)
    expect(arcs()).toHaveLength(0)
    expect(calls.filter((c) => c.op === 'createConicGradient')).toHaveLength(0)
  })

  test('the backing store is scaled for the device pixel ratio', () => {
    const { container } = render(
      <MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />,
    )
    const canvas = container.querySelector('canvas')!
    expect(canvas.width).toBe(200) // 100 * dpr(2)
    expect(canvas.style.width).toBe('100px')
    expect(calls[0]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] })
  })

  test('the track uses the systemGray token, not a CSS grey', () => {
    render(<MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />)
    expect(surface.track).toBe('rgba(142,142,147,0.16)')
  })
})
