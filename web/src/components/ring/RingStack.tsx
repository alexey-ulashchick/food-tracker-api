import { MacroRing } from './MacroRing'

// Port of CalTracker/RingStack.swift: concentric rings, protein outermost,
// each inset by (strokeWidth + gap) * 2 from the one outside it.

export type RingSpec = {
  value: number
  stops: readonly string[]
  /** Ratio unknown (no goal for the day) — render the track only. */
  dimmed?: boolean
}

type Props = {
  /** Expects three entries: protein, carbs, fat. */
  rings: RingSpec[]
  size?: number
  strokeWidth?: number
  gap?: number
}

export function RingStack({ rings, size = 240, strokeWidth = 18, gap = 4 }: Props) {
  // Nesting only works while every level still has room for its stroke. What
  // matters is the radius, not the box: at Today's 156/13/3 the innermost ring
  // lands on a radius of 39.5, but shrink the box to the 36pt chat strip and it
  // drops to 2.75 — narrower than the stroke itself, so the ring collapses into
  // a blob. Those small call sites render independent rings side by side (see
  // singleRingSpec), which is what the Swift original does too.
  if (import.meta.env.DEV) {
    const innerBox = size - (rings.length - 1) * (strokeWidth + gap) * 2
    const innerRadius = (innerBox - strokeWidth) / 2
    if (innerRadius < strokeWidth) {
      console.warn(
        `[RingStack] ${rings.length} rings do not fit in ${size}px at stroke ${strokeWidth}: ` +
          `the innermost radius would be ${innerRadius}. Render standalone rings instead.`,
      )
    }
  }

  return (
    <div style={{ width: size, height: size, position: 'relative' }}>
      {rings.map((ring, i) => {
        const inset = i * (strokeWidth + gap) * 2
        const inner = size - inset
        return (
          <div
            key={`${ring.stops.join()}-${i}`}
            style={{
              position: 'absolute',
              top: inset / 2,
              left: inset / 2,
              width: inner,
              height: inner,
            }}
          >
            <MacroRing
              value={ring.value}
              stops={ring.stops}
              size={inner}
              strokeWidth={strokeWidth}
              dimmed={ring.dimmed}
            />
          </div>
        )
      })}
    </div>
  )
}
