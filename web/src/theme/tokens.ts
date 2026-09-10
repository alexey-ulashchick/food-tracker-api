// Single source of truth for colour, radius and spacing.
//
// Colour values are `var(--c-…)` rather than literals, because there are two
// themes now and a stylesheet is the only thing that can switch between them: a
// custom property reaches through an inline style, so ~500 call sites written as
// `style={{ background: surface.card }}` keep working untouched while their
// computed value follows the OS. The literals themselves, dark and light side by
// side with the reasoning for each, live in the --c- block in index.css.
//
// Two consequences worth knowing:
//   * withAlpha uses color-mix, since it can no longer parse a hex string.
//   * Canvas cannot resolve a custom property. The ring and the pie call
//     resolveColor() to read the literal back out — see useColorScheme, which
//     redraws them when the OS theme flips.
//
// Two SwiftUI facts the port depends on, for whoever reads index.css:
//   * Color.gray is systemGray #8E8E93, NOT the CSS keyword gray (#808080).
//   * .secondary in dark mode is secondaryLabel rgba(235,235,245,0.6), and
//     .primary is pure white — neither is a plain grey.

export const surface = {
  /** Color(white: 0.11) — 36 call sites, the universal card background. */
  card: 'var(--c-card)',
  /** Color(white: 0.07) — token field, memory text fields. */
  input: 'var(--c-input)',
  /** Color(white: 0.18) — AI chat bubble, typing bubble. */
  bubble: 'var(--c-bubble)',
  /** Color(white: 0.16) — chart tooltip, day-nav circle buttons. */
  elevated: 'var(--c-elevated)',
  hairline: 'var(--c-hairline)',
  subtle: 'var(--c-subtle)',
  /** Color.gray.opacity(0.16) — ring track, calorie-meter bar track. */
  track: 'var(--c-track)',
  /** Color.gray.opacity(0.18) — composer buttons and capsule. */
  control: 'var(--c-control)',
  /** A row held down, and the same wash a pointer hovers with. */
  pressed: 'var(--c-pressed)',
} as const

export const label = {
  primary: 'var(--c-label)',
  secondary: 'var(--c-label2)',
  tertiary: 'var(--c-label3)',
} as const

/** AccentColor.colorset — iOS system orange. */
export const accent = 'var(--c-accent)'

/** Text on an accent-filled control: black in both themes. */
export const onAccent = 'var(--c-on-accent)'
/** Text on a saturated tint chip: white in both themes. */
export const onTint = 'var(--c-on-tint)'

/** iOS systemBlue. The user's chat bubble uses SwiftUI's .blue, not the app
 *  accent — a detail worth stating because the rest of the UI is orange. Links
 *  inside an AI bubble use it too. */
export const systemBlue = 'var(--c-blue)'

/** iOS systemRed. Drives the ring's overage ramp and the over-goal figures. */
export const overage = 'var(--c-overage)'

/** Destructive text and controls: Выйти, a rejected token, a failed save. */
export const danger = 'var(--c-danger)'

/** iOS systemGreen — the "on target" figures in the History metrics. */
export const positive = 'var(--c-positive)'

/** The Память section's tint. */
export const memoryTint = 'var(--c-memory)'

/** systemGray, for a disabled control's fill. */
export const systemGray = 'var(--c-gray)'

// Aurora is the only palette in use. Swift also defined `pulse` and `magma`,
// but no palette picker was ever built and AppState.palette never changed at
// runtime, so they are dropped rather than ported.
export const palette = {
  calories: ['var(--c-calories-0)', 'var(--c-calories-1)'],
  protein: ['var(--c-protein-0)', 'var(--c-protein-1)'],
  carbs: ['var(--c-carbs-0)', 'var(--c-carbs-1)'],
  fat: ['var(--c-fat-0)', 'var(--c-fat-1)'],
} as const

export type MacroKey = keyof typeof palette

/** Verdict scale shared by History bars, the Today verdict and recommendations. */
export const dietDayColor = {
  gray: 'var(--c-day-gray)',
  blue: 'var(--c-day-blue)',
  green: 'var(--c-day-green)',
  light_green: 'var(--c-day-light-green)',
  yellow: 'var(--c-day-yellow)',
  orange: 'var(--c-day-orange)',
  red: 'var(--c-day-red)',
} as const

export const dayTypeTint = { training: 'var(--c-training)', rest: 'var(--c-rest)' } as const

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

/**
 * Spacing still read from JS.
 *
 * The page-level values — screenX/screenTop/screenBottom/cardGap/maxWidth —
 * also exist as custom properties in index.css (`--page-x`, `--page-top`,
 * `--page-bottom`, `--card-gap`, `--shell-max`), and CSS is the source of
 * truth for them: only a stylesheet can widen them at a breakpoint. The copies
 * here are what remains for the few call sites still computing in JS. Change
 * one, change the other — same deliberate duplication as the colour block at
 * the top of index.css.
 */
export const layout = {
  screenX: 16,
  screenTop: 8,
  screenBottom: 24,
  cardGap: 14,
  cardPad: 14,
  cardPadWide: 16,
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

/**
 * Adds an alpha channel to any colour, including a `var(--c-…)`.
 *
 * color-mix rather than parsing to rgba(): the inputs are custom properties
 * now, and their literal is not available at this point. Mixing with
 * transparent yields exactly the requested alpha over the same colour.
 */
export function withAlpha(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${alpha * 100}%, transparent)`
}

/**
 * Reads the literal behind a `var(--c-…)`.
 *
 * Only for canvas, which cannot resolve custom properties: strokeStyle and
 * createConicGradient need a real colour. getPropertyValue returns the token as
 * authored — custom properties substitute rather than compute — so a hex stays
 * a hex and the ring's existing hexToRgb keeps working.
 */
export function resolveColor(value: string, root?: Element): string {
  const name = /^var\((--[\w-]+)\)$/.exec(value.trim())?.[1]
  if (!name) return value
  if (typeof document === 'undefined') return value
  const from = root ?? document.documentElement
  return getComputedStyle(from).getPropertyValue(name).trim() || value
}
