import { label, surface, withAlpha } from '@/theme/tokens'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'

// Port of CalTracker/CalorieMeter.swift — the horizontal "fuel" capsule that
// gives calories their own shape language so they do not compete with the
// macro rings.

export type MeterSize = 'small' | 'medium' | 'large'

const NUM_FONT: Record<MeterSize, number> = { large: 40, medium: 28, small: 22 }
const BAR_HEIGHT: Record<MeterSize, number> = { large: 14, medium: 10, small: 8 }

type Props = {
  current: number
  goal: number
  /** Two-stop palette gradient; the last stop is the tint. */
  stops: readonly string[]
  size?: MeterSize
  /** Rendered top-right, above the LEFT/OVER label so it never covers it. */
  accessory?: ReactNode
}

export function CalorieMeter({ current, goal, stops, size = 'large', accessory }: Props) {
  // Capped at 1.2 so a wild overshoot does not stretch the bar off the card;
  // the fill itself is clamped to 1.
  const pct = goal > 0 ? Math.min(1.2, current / goal) : 0
  const remaining = Math.max(0, goal - current)
  const over = Math.max(0, current - goal)
  const tint = stops[stops.length - 1] ?? '#FF9500'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 'calc(11px * var(--type))',
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: tint,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Flame color={tint} />
          Калории
        </span>
        <div style={{ marginLeft: 'auto' }}>{accessory}</div>
      </div>

      {/* Both halves share a baseline in Swift (.lastTextBaseline). */}
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            className="tnum"
            style={{ fontWeight: 700, fontSize: `calc(${NUM_FONT[size]}px * var(--type))` }}
          >
            {Math.round(current)}
          </span>
          <span
            className="tnum"
            style={{
              fontWeight: 500,
              fontSize: 'calc(14px * var(--type))',
              color: label.secondary,
            }}
          >
            / {Math.round(goal)}
          </span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 'calc(11px * var(--type))',
              letterSpacing: 0.5,
              color: label.secondary,
            }}
          >
            {over > 0 ? 'ПЕРЕБОР' : 'ОСТАЛОСЬ'}
          </span>
          <span
            className="tnum"
            style={{
              fontWeight: 700,
              fontSize: `calc(${size === 'large' ? 28 : 20}px * var(--type))`,
              color: over > 0 ? '#FF3B30' : tint,
            }}
          >
            {over > 0 ? Math.round(over) : Math.round(remaining)}
          </span>
        </span>
      </div>

      <div
        style={{
          height: BAR_HEIGHT[size],
          borderRadius: 999,
          background: surface.track,
          overflow: 'hidden',
        }}
      >
        <motion.div
          // spring(response: 1.1, dampingFraction: 0.7) in Swift.
          animate={{ width: `${Math.min(1, pct) * 100}%` }}
          initial={false}
          transition={{ type: 'spring', duration: 1.1, bounce: 0.3 }}
          style={{
            height: '100%',
            borderRadius: 999,
            background: `linear-gradient(to right, ${stops.join(', ')})`,
            boxShadow: `0 0 6px ${withAlpha(tint, 0.45)}`,
          }}
        />
      </div>
    </div>
  )
}

/** SF Symbol flame.fill. */
function Flame({ color }: { color: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M12 2c.6 3.2-1.3 4.6-2.6 6C8 9.5 7 10.9 7 13a5 5 0 0 0 10 0c0-2.6-1.6-4.3-2.8-5.8C13 5.7 12.3 4.2 12 2Zm.2 10c.3 1.3-.6 1.9-1.1 2.5-.5.6-.8 1.2-.8 2a2 2 0 0 0 4 0c0-1-.6-1.7-1.1-2.4-.5-.6-.9-1.2-1-2.1Z" />
    </svg>
  )
}
