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
