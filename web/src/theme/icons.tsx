// Hand-drawn stand-ins for the SF Symbols the Swift app uses. Written out
// rather than pulled from an icon set because only a handful are needed and
// each has to match a specific SF Symbol's silhouette; a generic set would
// drift from the original.
//
// All take a size and inherit `currentColor` so callers style them with the
// surrounding text colour.

type IconProps = { size?: number; color?: string }

function Svg({ size = 14, color, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color ?? 'currentColor'}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {children}
    </svg>
  )
}

/** checkmark.circle.fill */
export function CheckCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.7 7.7-5.5 5.6a1 1 0 0 1-1.4 0l-2.5-2.6a1 1 0 0 1 1.4-1.4l1.8 1.8 4.8-4.8a1 1 0 0 1 1.4 1.4Z" />
    </Svg>
  )
}

/** minus.circle.fill */
export function MinusCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4 11H8a1 1 0 0 1 0-2h8a1 1 0 0 1 0 2Z" />
    </Svg>
  )
}

/** pencil.circle.fill */
export function PencilCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.3 6.5-1 1-2-2 1-1a.7.7 0 0 1 1 0l1 1a.7.7 0 0 1 0 1Zm-2 2L9.7 15H7.6v-2.1l4.7-4.6 2 2Z" />
    </Svg>
  )
}

/** target */
export function TargetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm0 2a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
    </Svg>
  )
}

/** brain.head.profile */
export function BrainIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15.5 2c-3.6 0-6.5 2.5-7 5.8-.2 1.2-.7 1.9-1.3 2.6-.5.6-1.2 1.3-1.2 2.3 0 .8.5 1.4 1.1 1.7.4.2.6.3.6.7V17a3 3 0 0 0 3 3h1.8a1 1 0 0 0 1-1v-1.6a1 1 0 0 1 1-1h1.7a1 1 0 0 0 1-1V13a1 1 0 0 1 1-1H21a1 1 0 0 0 .9-1.4A7.5 7.5 0 0 0 15.5 2Zm-2.7 5.3a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Zm3.9 1.4a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
    </Svg>
  )
}

/** checkmark.seal.fill */
export function SealCheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 1.8 14.2 3l2.5-.4 1.4 2.1 2.3 1.1-.2 2.5L21.8 10l-1.6 2 .2 2.5-2.3 1.1-1.4 2.1-2.5-.4-2.2 1.2-2.2-1.2-2.5.4-1.4-2.1L2.2 14.5 2.4 12 .8 10l1.6-1.7-.2-2.5 2.3-1.1L5.9 2.6 8.4 3 12 1.8Zm4.2 6.6a1 1 0 0 0-1.4 0L11 12.2l-1.8-1.8a1 1 0 0 0-1.4 1.4l2.5 2.5a1 1 0 0 0 1.4 0l4.5-4.5a1 1 0 0 0 0-1.4Z" />
    </Svg>
  )
}

/** exclamationmark.circle.fill */
export function WarnCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.8a1 1 0 0 1 1 1.1l-.3 4.6a.7.7 0 0 1-1.4 0l-.3-4.6a1 1 0 0 1 1-1.1Zm0 8.4a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z" />
    </Svg>
  )
}

/** arrow.right */
export function ArrowRightIcon({ size = 9, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  )
}

// ── Tab bar ───────────────────────────────────────────────────────────────
// SwiftUI used circle.dotted.circle.fill / bubble.left.fill / calendar /
// person.circle.fill. Filled shapes so the active tint reads clearly at 24px.

/** circle.dotted.circle.fill — a dotted ring around a solid core. */
export function TodayTabIcon({ size = 24, color }: IconProps) {
  const dots = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2
    return { cx: 12 + Math.cos(a) * 9.5, cy: 12 + Math.sin(a) * 9.5 }
  })
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color ?? 'currentColor'}
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {dots.map((d) => (
        <circle key={`${d.cx}-${d.cy}`} cx={d.cx} cy={d.cy} r={1.15} />
      ))}
      <circle cx={12} cy={12} r={5.5} />
    </svg>
  )
}

/** bubble.left.fill */
export function ChatTabIcon(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 24}>
      <path d="M12 3c5 0 9 3.2 9 7.3 0 4-4 7.2-9 7.2-1 0-2-.1-2.9-.4l-4 2.4a.6.6 0 0 1-.9-.7l1-3.3C3.2 14.4 3 12.5 3 10.3 3 6.2 7 3 12 3Z" />
    </Svg>
  )
}

/** calendar */
export function HistoryTabIcon({ size = 24, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={1.9}
      strokeLinecap="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <rect x={3} y={5} width={18} height={16} rx={3} />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <circle cx={8.5} cy={14.5} r={1.1} fill={color ?? 'currentColor'} stroke="none" />
      <circle cx={12} cy={14.5} r={1.1} fill={color ?? 'currentColor'} stroke="none" />
      <circle cx={15.5} cy={14.5} r={1.1} fill={color ?? 'currentColor'} stroke="none" />
    </svg>
  )
}

/** person.circle.fill */
export function YouTabIcon(props: IconProps) {
  return (
    <Svg {...props} size={props.size ?? 24}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.2a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 13.9a7.9 7.9 0 0 1-5.4-2.1c.5-2.3 2.8-3.6 5.4-3.6s4.9 1.3 5.4 3.6A7.9 7.9 0 0 1 12 20.1Z" />
    </Svg>
  )
}

/** chevron.left / chevron.right */
export function ChevronIcon({ size = 15, color, dir }: IconProps & { dir: 'left' | 'right' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
}

/** eye / eye.slash — the token field's reveal toggle. */
export function EyeIcon({ size = 16, color, off }: IconProps & { off?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={1.9}
      strokeLinecap="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx={12} cy={12} r={2.8} />
      {off ? <path d="M4 20 20 4" /> : null}
    </svg>
  )
}

/** fork.knife */
export function ForkKnifeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 2a.8.8 0 0 1 .8.8V8a1.4 1.4 0 0 0 2.8 0V2.8a.8.8 0 0 1 1.6 0V8a3 3 0 0 1-2.2 2.9V21a.8.8 0 0 1-1.6 0V10.9A3 3 0 0 1 5.4 8V2.8A.8.8 0 0 1 6.2 2Zm10.6 0a.8.8 0 0 1 .8.8v6.9c0 1-.5 1.9-1.4 2.4V21a.8.8 0 0 1-1.6 0v-8.9c-.9-.5-1.4-1.4-1.4-2.4V2.8a.8.8 0 0 1 1.6 0v6.9c0 .4.2.7.6.9V2.8a.8.8 0 0 1 1.4 0Z" />
    </Svg>
  )
}

/** checkmark */
export function TickIcon({ size = 16, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path d="M4 12.5 9.5 18 20 6.5" />
    </svg>
  )
}

/**
 * Inline activity indicator. Replaces SwiftUI's ProgressView(.small); the
 * animation lives in index.css so it does not need a JS ticker.
 */
export function Spinner({ size = 14, color }: IconProps) {
  return (
    <span
      className="spinner"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderWidth: Math.max(1.5, size / 9),
        borderColor: color ?? 'rgba(235,235,245,0.35)',
        borderTopColor: color ?? 'rgba(235,235,245,0.9)',
        flexShrink: 0,
      }}
    />
  )
}

/** flame.fill */
export function FlameIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2c.6 3.2-1.3 4.6-2.6 6C8 9.5 7 10.9 7 13a5 5 0 0 0 10 0c0-2.6-1.6-4.3-2.8-5.8C13 5.7 12.3 4.2 12 2Zm.2 10c.3 1.3-.6 1.9-1.1 2.5-.5.6-.8 1.2-.8 2a2 2 0 0 0 4 0c0-1-.6-1.7-1.1-2.4-.5-.6-.9-1.2-1-2.1Z" />
    </Svg>
  )
}

/** tray */
export function TrayIcon({ size = 15, color }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M3 13h4l1.5 3h7L17 13h4" />
      <path d="M4.5 5.5h15L21 13v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l1.5-7.5Z" />
    </svg>
  )
}
