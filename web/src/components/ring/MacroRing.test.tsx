import { palette, surface } from '@/theme/tokens'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MacroRing } from './MacroRing'
import { OVERAGE_END_T } from './ringColor'

// jsdom has no canvas backend, so the 2D context is replaced with a recorder.
//
// It also loads no stylesheets, so the colour tokens — which are custom
// properties now, resolved by the ring because canvas cannot read them — come
// back empty. The dark literals are stubbed in below; in a browser the same
// lookup returns them from index.css.
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
  // Property assignments are recorded too, so a test can assert the colour a
  // shape was actually painted with rather than inferring it from gradient
  // stops.
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
    set fillStyle(v: unknown) {
      calls.push({ op: 'set:fillStyle', args: [v] })
    },
    set strokeStyle(v: unknown) {
      calls.push({ op: 'set:strokeStyle', args: [v] })
    },
    set shadowBlur(v: unknown) {
      calls.push({ op: 'set:shadowBlur', args: [v] })
    },
    set shadowColor(v: unknown) {
      calls.push({ op: 'set:shadowColor', args: [v] })
    },
    set lineWidth(v: unknown) {
      calls.push({ op: 'set:lineWidth', args: [v] })
    },
    set lineCap(v: unknown) {
      calls.push({ op: 'set:lineCap', args: [v] })
    },
    set lineJoin(v: unknown) {
      calls.push({ op: 'set:lineJoin', args: [v] })
    },
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

/** The value assigned to a property immediately before the given call index. */
function valueBefore(op: string, index: number): unknown {
  for (let i = index - 1; i >= 0; i--) {
    if (calls[i]!.op === op) return calls[i]!.args[0]
  }
  return undefined
}

/** The dark values from index.css, for the tokens these tests exercise. */
const TOKENS: Record<string, string> = {
  '--c-track': 'rgba(142,142,147,0.16)',
  '--c-overage': '#FF3B30',
  '--c-calories-0': '#FFD180',
  '--c-calories-1': '#FF8A65',
  '--c-protein-0': '#80D8FF',
  '--c-protein-1': '#0091EA',
  '--c-carbs-0': '#CCFF90',
  '--c-carbs-1': '#64DD17',
  '--c-fat-0': '#E1BEE7',
  '--c-fat-1': '#7C4DFF',
}

// Captured at module scope, before any spy exists. Taken inside beforeEach it
// would be the previous test's spy, and the delegation would recurse.
const realComputedStyle = window.getComputedStyle.bind(window)

beforeEach(() => {
  calls = []
  gradientStops = []
  // Delegating rather than replacing: anything else that asks for a computed
  // style still gets jsdom's answer.
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((
    el: Element,
    pseudo?: string | null,
  ) => {
    const base = realComputedStyle(el, pseudo ?? undefined)
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'getPropertyValue') {
          return (name: string) => TOKENS[name] ?? target.getPropertyValue(name)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }) as typeof window.getComputedStyle)
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
    // The arc itself occupies a quarter turn, so its colour ramp must finish by
    // 0.25 — a stop past that would mean the gradient was laid out across the
    // whole turn instead of the segment. The two stops beyond it are the
    // deliberate cap holds, checked separately below.
    const rampEnd = 0.25
    const ramp = gradientStops.filter((s) => s.offset <= rampEnd)
    expect(ramp.length).toBeGreaterThanOrEqual(2)
    expect(ramp.at(-1)!.offset).toBeCloseTo(rampEnd, 9)
    expect(gradientStops.some((s) => s.offset === 1)).toBe(true)
  })

  test('each segment gets its own gradient anchored at its start angle', () => {
    render(<MacroRing value={1} stops={palette.protein} size={100} strokeWidth={10} />)
    const grads = calls.filter((c) => c.op === 'createConicGradient')
    expect(grads).toHaveLength(4)
    expect(deg((grads[0]!.args as number[])[0]!)).toBeCloseTo(0, 6)
    expect(deg((grads[1]!.args as number[])[0]!)).toBeCloseTo(90, 6)
  })

  // Regression: a round cap overhangs the arc at both ends, and the leading one
  // reaches back past 0° — which in a conic gradient wraps to just under 1.0.
  // Painting the end colour there made every segment stamp its darkest shade
  // over the previous one, visible as notches at 90°, 180° and 270°.
  test('the wrap-around region carries the start colour, not the end colour', () => {
    render(<MacroRing value={1} stops={palette.protein} size={100} strokeWidth={10} />)

    // Second segment: starts at t = 0.25, ends at 0.5. Its start colour must be
    // what sits at offset 1, so the leading cap cannot darken segment one.
    const perSegment = gradientStops.reduce<Array<Array<{ offset: number; color: string }>>>(
      (acc, stop) => {
        if (stop.offset === 0) acc.push([])
        acc[acc.length - 1]?.push(stop)
        return acc
      },
      [],
    )
    expect(perSegment).toHaveLength(4)

    for (const seg of perSegment) {
      const first = seg[0]!
      const last = seg.at(-1)!
      expect(last.offset).toBe(1)
      expect(last.color).toBe(first.color)
    }
  })

  test('the end colour is held just past the arc to cover the trailing cap', () => {
    render(<MacroRing value={0.25} stops={palette.protein} size={100} strokeWidth={10} />)
    const share = 0.25
    // radius 45, strokeWidth 10 → cap spans 5/45 rad, ~0.0177 of a turn.
    const capFrac = 10 / 2 / 45 / (Math.PI * 2)
    const held = gradientStops.find((s) => s.offset > share && s.offset < 1)
    expect(held).toBeDefined()
    expect(held!.offset).toBeCloseTo(share + capFrac * 1.5, 6)
  })

  test('gradient offsets stay within [0, 1] and never descend', () => {
    for (const value of [0.05, 0.25, 1, 1.15, 2.3]) {
      gradientStops = []
      calls = []
      render(<MacroRing value={value} stops={palette.fat} size={92} strokeWidth={9} />)
      let prev = -1
      for (const stop of gradientStops) {
        expect(stop.offset).toBeGreaterThanOrEqual(0)
        expect(stop.offset).toBeLessThanOrEqual(1)
        // A new segment restarts at 0; within a segment offsets ascend.
        if (stop.offset === 0) prev = 0
        else {
          expect(stop.offset).toBeGreaterThanOrEqual(prev)
          prev = stop.offset
        }
      }
    }
  })

  test('the overage knee turns the head red once the ramp completes', () => {
    render(<MacroRing value={OVERAGE_END_T} stops={palette.protein} size={100} strokeWidth={10} />)
    // Read the fill actually assigned before the head is painted, rather than
    // inferring it from gradient stops.
    const firstFill = calls.findIndex((c) => c.op === 'fill')
    expect(valueBefore('set:fillStyle', firstFill)).toBe('rgb(255, 59, 48)')
  })

  test('under the goal the head takes the palette end colour', () => {
    render(<MacroRing value={1} stops={palette.protein} size={100} strokeWidth={10} />)
    const firstFill = calls.findIndex((c) => c.op === 'fill')
    // protein's last stop, #0091EA.
    expect(valueBefore('set:fillStyle', firstFill)).toBe('rgb(0, 145, 234)')
  })

  test('the head shadow is opaque black and scales with the stroke', () => {
    render(<MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />)
    const firstFill = calls.findIndex((c) => c.op === 'fill')
    expect(valueBefore('set:shadowColor', firstFill)).toBe('rgba(0,0,0,1)')
    // SwiftUI radius is sigma and canvas blur is 2 * sigma; two stacked
    // shadows convolve to sigma * sqrt(2). Missing either factor makes the
    // shadow visibly too tight.
    expect(valueBefore('set:shadowBlur', firstFill)).toBeCloseTo(10 * 0.18 * Math.SQRT2 * 2, 9)
  })

  test('segments are stroked with round caps, matching the Swift StrokeStyle', () => {
    render(<MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />)
    expect(calls.some((c) => c.op === 'set:lineCap' && c.args[0] === 'round')).toBe(true)
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
    // strokeWidth 10 → blur 5.09 → pad ceil(10.18) = 11. Box 100 + 2 * 11 = 122.
    expect(canvas.width).toBe(244)
    expect(canvas.style.width).toBe('122px')
    // The origin is shifted so ring coordinates still run 0..size.
    expect(calls[0]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 22, 22] })
  })

  // Regression: the head's outer edge sits exactly on size/2, so with a canvas
  // the same size as the layout box its drop shadow was sliced off at the
  // boundary. SwiftUI's .frame() does not clip, and that escaping shadow is
  // what makes the ring look layered.
  test('the canvas overhangs the layout box so the head shadow is not clipped', () => {
    const { container } = render(
      <MacroRing value={0.75} stops={palette.protein} size={156} strokeWidth={13} />,
    )
    const box = container.querySelector('span')!
    const canvas = container.querySelector('canvas')!

    expect(box.style.width).toBe('156px')
    expect(Number.parseFloat(canvas.style.width)).toBeGreaterThan(156)
    expect(canvas.style.top).toBe(canvas.style.left)

    // The overhang must clear the whole Gaussian tail (~3 sigma = 1.5 * blur),
    // or the shadow is still sliced at the boundary.
    const blur = 13 * 0.18 * Math.SQRT2 * 2
    const overhang = (Number.parseFloat(canvas.style.width) - 156) / 2
    expect(overhang).toBeGreaterThanOrEqual(blur * 1.5)
  })

  test('the shadow padding scales with the stroke so it is never clipped', () => {
    for (const strokeWidth of [3.5, 4.5, 9, 13, 18]) {
      calls = []
      const { container, unmount } = render(
        <MacroRing value={0.6} stops={palette.protein} size={120} strokeWidth={strokeWidth} />,
      )
      const canvas = container.querySelector('canvas')!
      const overhang = (Number.parseFloat(canvas.style.width) - 120) / 2
      const blur = strokeWidth * 0.18 * Math.SQRT2 * 2
      expect(overhang, `stroke ${strokeWidth}`).toBeGreaterThanOrEqual(blur * 1.5)
      unmount()
    }
  })

  test('the cleared area covers the padding, not just the box', () => {
    render(<MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />)
    const clear = calls.find((c) => c.op === 'clearRect')!
    expect(clear.args).toEqual([-11, -11, 122, 122])
  })

  // Geometry the screenshot could not settle: rings must be concentric and
  // shrink by exactly (strokeWidth + gap) * 2 per level.
  test('a ring is centred in its own box whatever the size', () => {
    for (const size of [26, 36, 92, 156, 240]) {
      calls = []
      const strokeWidth = 13
      render(
        <MacroRing value={0.5} stops={palette.protein} size={size} strokeWidth={strokeWidth} />,
      )
      const track = calls.find((c) => c.op === 'arc')!
      const [cx, cy, radius] = track.args as number[]
      expect(cx).toBeCloseTo(size / 2, 9)
      expect(cy).toBeCloseTo(size / 2, 9)
      expect(radius).toBeCloseTo((size - strokeWidth) / 2, 9)
    }
  })

  // The token is a custom property now, so what matters is that the ring
  // RESOLVES it before handing it to the context: canvas would silently paint
  // nothing for a literal `var(--c-track)`.
  test('the track is stroked with the resolved token, not the var() text', () => {
    render(<MacroRing value={0.5} stops={palette.protein} size={100} strokeWidth={10} />)
    expect(surface.track).toBe('var(--c-track)')

    const firstStroke = calls.findIndex((c) => c.op === 'stroke')
    const painted = valueBefore('set:strokeStyle', firstStroke)
    expect(painted).toBe('rgba(142,142,147,0.16)')
    expect(String(painted)).not.toContain('var(')
  })
})
