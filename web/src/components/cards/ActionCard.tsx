import { label, palette, radius, surface } from '@/theme/tokens'
import type { ReactNode } from 'react'

// Shared chrome for the action cards the chat shows after the LLM ran a write
// tool. Ported from CalTracker/FoodCard.swift: rounded surface, 300px cap,
// left-aligned inside a full-width row.
//
// There are deliberately no accept/reject controls — by the time a card lands
// the write is already committed in the database.

export function ActionCard({
  children,
  pad = 'tight',
  borderColor,
  cornerRadius = radius.actionCard,
  background = surface.card,
  minHeight,
}: {
  children: ReactNode
  /** `tight` is 14/10 (most cards); `even` is 14 all round (GoalCard). */
  pad?: 'tight' | 'even' | 'roomy'
  borderColor?: string
  cornerRadius?: number
  background?: string
  minHeight?: number | string
}) {
  const padding = pad === 'even' ? 14 : pad === 'roomy' ? '12px 14px' : '10px 14px'
  return (
    <div style={{ display: 'flex' }}>
      <div
        // Anchors the end-to-end assertions. Card copy shares vocabulary with
        // the bubbles around it — the recap for a logged apple says "яблоко"
        // too — so text alone cannot address a card unambiguously.
        data-testid="action-card"
        style={{
          maxWidth: 300,
          width: '100%',
          minHeight,
          padding,
          borderRadius: cornerRadius,
          background,
          // Swift draws the tint as an overlay stroke, which sits inside the
          // rounded rect — inset box-shadow is the CSS equivalent that does not
          // affect layout.
          boxShadow: borderColor ? `inset 0 0 0 1px ${borderColor}` : undefined,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** The `Added` / `Updated` / `Goal set` line at the top of every card. */
export function StatusBadge({
  icon,
  text,
  color,
}: {
  icon: ReactNode
  text: string
  color: string
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontWeight: 600,
        fontSize: 11.5,
        color,
      }}
    >
      {icon}
      {text}
    </span>
  )
}

export type MacroKind = 'protein' | 'carbs' | 'fat'

const MACRO_LETTER: Record<MacroKind, string> = { protein: 'Б', carbs: 'У', fat: 'Ж' }

/**
 * `Б 32` style chip. The letter takes the macro's colour, the number stays
 * secondary — same weighting as the Swift macroChip.
 */
export function MacroChip({
  kind,
  value,
  unit,
}: {
  kind: MacroKind
  value: number
  unit?: string
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3 }}>
      <span style={{ fontWeight: 700, fontSize: 11.5, color: palette[kind][1] }}>
        {MACRO_LETTER[kind]}
      </span>
      <span className="tnum" style={{ fontWeight: 400, fontSize: 11.5, color: label.secondary }}>
        {Math.round(value)}
        {unit ?? ''}
      </span>
    </span>
  )
}

/** kcal figure in the calorie tint, used by every card's right edge. */
export function Kcal({
  value,
  size = 15,
  muted,
  suffix,
}: {
  value: number
  size?: number
  muted?: boolean
  suffix?: string
}) {
  return (
    <span
      className="tnum"
      style={{
        fontWeight: 700,
        fontSize: size,
        color: muted ? label.secondary : palette.calories[1],
        whiteSpace: 'nowrap',
      }}
    >
      {Math.round(value)}
      {suffix ?? ''}
    </span>
  )
}

export const cardDivider = {
  height: 1,
  background: surface.subtle,
  border: 0,
  margin: 0,
} as const
