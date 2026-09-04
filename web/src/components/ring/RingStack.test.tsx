import { palette, ringSpec, singleRingSpec } from '@/theme/tokens'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { RingStack } from './RingStack'

// The screenshot review could not settle whether the nested rings were truly
// concentric, so the arithmetic is pinned here instead: every ring must share
// one centre in the stack's coordinate space and step down by exactly
// (strokeWidth + gap) * 2 per level.

type Call = { op: string; args: unknown[] }
let calls: Call[] = []

beforeEach(() => {
  calls = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const record =
      (op: string) =>
      (...args: unknown[]) => {
        calls.push({ op, args })
      }
    return {
      setTransform: record('setTransform'),
      clearRect: record('clearRect'),
      beginPath: record('beginPath'),
      arc: record('arc'),
      stroke: record('stroke'),
      fill: record('fill'),
      save: record('save'),
      restore: record('restore'),
      createConicGradient: () => ({ addColorStop: () => {} }),
    } as unknown as RenderingContext
  })
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal('devicePixelRatio', 1)
})

const three = [
  { value: 0.78, stops: palette.protein },
  { value: 0.54, stops: palette.carbs },
  { value: 1.14, stops: palette.fat },
]

/**
 * The full-circle track arc each ring draws first: [cx, cy, radius].
 *
 * Head circles are full circles too, so radius alone is not enough to tell
 * them apart — they are drawn at strokeWidth / 2, which is always well under a
 * ring radius, hence the threshold.
 */
function tracks(strokeWidth: number) {
  return calls
    .filter((c) => c.op === 'arc')
    .map((c) => c.args as number[])
    .filter(([, , , start, end]) => Math.abs((end ?? 0) - (start ?? 0) - Math.PI * 2) < 1e-9)
    .filter(([, , radius]) => (radius ?? 0) > strokeWidth)
    .map(([cx, cy, radius]) => ({ cx: cx!, cy: cy!, radius: radius! }))
}

describe('RingStack geometry', () => {
  test('renders one canvas per ring', () => {
    const { container } = render(<RingStack rings={three} size={156} strokeWidth={13} gap={3} />)
    expect(container.querySelectorAll('canvas')).toHaveLength(3)
  })

  test('each ring shrinks by (strokeWidth + gap) * 2 per level', () => {
    const { container } = render(<RingStack rings={three} size={156} strokeWidth={13} gap={3} />)
    const boxes = [...container.querySelectorAll('canvas')].map(
      (c) => (c.parentElement as HTMLElement).style.width,
    )
    // 156 → 124 → 92, a 32px step for strokeWidth 13 and gap 3.
    expect(boxes).toEqual(['156px', '124px', '92px'])
  })

  test('all three rings share one centre in stack coordinates', () => {
    const { container } = render(<RingStack rings={three} size={156} strokeWidth={13} gap={3} />)
    const wrappers = [...container.querySelectorAll('canvas')].map(
      (c) => c.parentElement?.parentElement as HTMLElement,
    )
    const t = tracks(13)
    expect(t).toHaveLength(3)

    const centres = t.map((track, i) => ({
      x: Number.parseFloat(wrappers[i]!.style.left) + track.cx,
      y: Number.parseFloat(wrappers[i]!.style.top) + track.cy,
    }))
    for (const c of centres) {
      expect(c.x).toBeCloseTo(78, 6) // size / 2
      expect(c.y).toBeCloseTo(78, 6)
    }
  })

  test('the bands do not overlap and are separated by exactly the gap', () => {
    render(<RingStack rings={three} size={156} strokeWidth={13} gap={3} />)
    const strokeWidth = 13
    const radii = tracks(strokeWidth).map((t) => t.radius)
    // Outer edge of ring i+1 to inner edge of ring i.
    for (let i = 1; i < radii.length; i++) {
      const innerEdgeOfOuter = radii[i - 1]! - strokeWidth / 2
      const outerEdgeOfInner = radii[i]! + strokeWidth / 2
      expect(innerEdgeOfOuter - outerEdgeOfInner).toBeCloseTo(3, 6)
    }
  })

  // Every spec that IS a stack must leave the innermost ring wider than its
  // own stroke. This is the check that caught the chat strip and History row
  // being mislabelled as stacks: at 36/4.5 the third ring's radius is 2.75.
  test('every stack spec leaves room for all three strokes', () => {
    for (const [name, spec] of Object.entries(ringSpec)) {
      calls = []
      render(
        <RingStack rings={three} size={spec.size} strokeWidth={spec.strokeWidth} gap={spec.gap} />,
      )
      const radii = tracks(spec.strokeWidth).map((t) => t.radius)
      expect(radii, name).toHaveLength(3)
      for (const r of radii) {
        expect(r, `${name} radius`).toBeGreaterThan(spec.strokeWidth)
      }
    }
  })

  test('the standalone specs are NOT viable as stacks', () => {
    // Documents why historyRow and chatStrip live in singleRingSpec: nesting
    // them collapses the innermost ring.
    for (const [name, spec] of Object.entries(singleRingSpec)) {
      // Assume the tightest plausible gap of 2; the radius still collapses.
      const innerBox = spec.size - 2 * (spec.strokeWidth + 2) * 2
      const innerRadius = (innerBox - spec.strokeWidth) / 2
      expect(innerRadius, name).toBeLessThan(spec.strokeWidth)
    }
  })

  test('warns in dev when the rings cannot fit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<RingStack rings={three} size={36} strokeWidth={4.5} gap={2} />)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('do not fit')
    warn.mockRestore()
  })

  test('a dimmed ring draws its track but no gradient', () => {
    render(
      <RingStack
        rings={three.map((r) => ({ ...r, dimmed: true }))}
        size={56}
        strokeWidth={6}
        gap={2}
      />,
    )
    expect(tracks(6)).toHaveLength(3)
    expect(calls.filter((c) => c.op === 'createConicGradient')).toHaveLength(0)
  })

  test('protein sits outermost, matching the Swift stack order', () => {
    const { container } = render(<RingStack rings={three} size={156} strokeWidth={13} gap={3} />)
    const first = container.querySelector('canvas')?.parentElement as HTMLElement
    expect(first.style.width).toBe('156px')
  })
})
