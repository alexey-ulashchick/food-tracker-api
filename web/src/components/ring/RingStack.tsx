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
