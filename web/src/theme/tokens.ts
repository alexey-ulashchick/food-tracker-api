// Single source of truth for colour, radius and spacing. Values are lifted
// verbatim from CalTracker/Theme.swift and the SwiftUI view bodies — this is a
// pixel-faithful port, so nothing here is "close enough".
//
// Two SwiftUI facts that are easy to get wrong in CSS:
//   * Color.gray is systemGray #8E8E93, NOT the CSS keyword gray (#808080).
//   * .secondary in dark mode is secondaryLabel rgba(235,235,245,0.6), and
//     .primary is pure white — neither is a plain grey.

export const surface = {
  /** Color(white: 0.11) — 36 call sites, the universal card background. */
  card: '#1C1C1C',
  /** Color(white: 0.07) — token field, memory text fields. */
  input: '#121212',
  /** Color(white: 0.18) — AI chat bubble, typing bubble. */
  bubble: '#2E2E2E',
  /** Color(white: 0.16) — chart tooltip, day-nav circle buttons. */
  elevated: '#292929',
  hairline: 'rgba(255,255,255,0.06)',
  subtle: 'rgba(255,255,255,0.08)',
  /** Color.gray.opacity(0.16) — ring track, calorie-meter bar track. */
  track: 'rgba(142,142,147,0.16)',
  /** Color.gray.opacity(0.18) — composer buttons and capsule. */
  control: 'rgba(142,142,147,0.18)',
} as const

export const label = {
  primary: '#FFFFFF',
  secondary: 'rgba(235,235,245,0.6)',
  tertiary: 'rgba(235,235,245,0.3)',
} as const

/** AccentColor.colorset — iOS system orange. */
export const accent = '#FF9500'

/** iOS systemBlue in dark mode. The user's chat bubble uses SwiftUI's .blue,
 *  not the app accent — a detail worth stating because the rest of the UI is
 *  orange. Links inside an AI bubble use it too. */
export const systemBlue = '#0A84FF'

/** iOS systemRed, rgb(1.0, 0.23, 0.19). Drives the ring's overage ramp. */
export const overage = '#FF3B30'

// Aurora is the only palette in use. Swift also defined `pulse` and `magma`,
// but no palette picker was ever built and AppState.palette never changed at
// runtime, so they are dropped rather than ported.
export const palette = {
  calories: ['#FFD180', '#FF8A65'],
  protein: ['#80D8FF', '#0091EA'],
  carbs: ['#CCFF90', '#64DD17'],
  fat: ['#E1BEE7', '#7C4DFF'],
} as const

export type MacroKey = keyof typeof palette

/** Verdict scale shared by History bars, the Today verdict and recommendations. */
export const dietDayColor = {
  gray: '#6E6E73',
  blue: '#5AC8FA',
  green: '#34C759',
  light_green: '#9FE3A0',
  yellow: '#FFD60A',
  orange: '#FF9F0A',
  red: '#FF453A',
} as const

export const dayTypeTint = { training: '#FF9500', rest: '#30B0C7' } as const

/** Chip backgrounds are always the tint at 18% — DayType.tint.opacity(0.18). */
export const CHIP_BG_ALPHA = 0.18

export const radius = {
  card: 18,
  actionCard: 16,
  errorCard: 14,
  field: 10,
  tooltip: 8,
  iconTile: 7,
  bar: 3,
} as const

export const layout = {
  screenX: 16,
  screenTop: 8,
  screenBottom: 24,
  cardGap: 14,
  cardPad: 14,
  cardPadWide: 16,
  /** Mobile-first; on wider screens the app stays a centred phone-width column. */
  maxWidth: 480,
} as const

/**
 * Ring geometry per call site, from the Swift view bodies.
 *
 * Only Today nests its rings. History rows and the chat macro strip render
 * three INDEPENDENT rings side by side (ringFor(idx:) and the P/C/F strip
 * respectively) — nesting at those sizes is not just wrong, it is degenerate:
 * a 26pt stack with a 3.5pt stroke leaves the third ring a radius of 0.25.
 */
export const ringSpec = {
  todayStack: { size: 156, strokeWidth: 13, gap: 3 },
  defaultStack: { size: 240, strokeWidth: 18, gap: 4 },
} as const

/** Standalone rings, one per macro, laid out in a row. */
export const singleRingSpec = {
  historyRow: { size: 26, strokeWidth: 3.5 },
  chatStrip: { size: 36, strokeWidth: 4.5 },
} as const

/** Adds an alpha channel to a #RRGGBB literal. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
