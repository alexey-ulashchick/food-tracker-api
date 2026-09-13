import { accent, label, onAccent, radius, surface, systemGray, withAlpha } from '@/theme/tokens'

// The project has no form primitives — there is not a single type="number" or
// <select> in web/src — and for a long time it needed none, because Memories
// was the only screen that wrote anything. The training settings made it two,
// so these four constants moved out of Memories.tsx rather than being copied.
//
// Styles, not components: every field on both screens differs in layout, and a
// <Field> wrapper would have collected a prop per difference. What is actually
// shared is the look.

export const fieldStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'none',
  background: surface.input,
  border: 0,
  borderRadius: radius.field,
  color: label.primary,
  fontWeight: 400,
  fontSize: 'calc(14px * var(--type))',
  padding: '10px 12px',
  lineHeight: 1.35,
}

export const iconButtonStyle: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  color: label.secondary,
  padding: 4,
  cursor: 'pointer',
  display: 'flex',
  flexShrink: 0,
}

export const ghostButtonStyle: React.CSSProperties = {
  border: 0,
  borderRadius: radius.field,
  background: surface.control,
  color: label.primary,
  fontWeight: 600,
  fontSize: 'calc(13px * var(--type))',
  padding: '8px 12px',
  cursor: 'pointer',
}

export function primaryButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    border: 0,
    borderRadius: radius.field,
    background: enabled ? accent : withAlpha(systemGray, 0.18),
    color: enabled ? onAccent : label.secondary,
    fontWeight: 600,
    fontSize: 'calc(13px * var(--type))',
    padding: '8px 12px',
    cursor: enabled ? 'pointer' : 'default',
  }
}

export function dangerButtonStyle(enabled = true): React.CSSProperties {
  return {
    ...ghostButtonStyle,
    background: 'transparent',
    color: enabled ? label.secondary : label.tertiary,
    padding: '8px 10px',
    cursor: enabled ? 'pointer' : 'default',
  }
}
