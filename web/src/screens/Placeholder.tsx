import { ScreenHeader } from '@/components/ScreenHeader'
import { label, layout, radius, surface } from '@/theme/tokens'

// Stand-in for a screen that has not been ported yet. Keeps the shell
// navigable — tab switching, safe areas and the error banner can all be
// exercised before the real screens land.

export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div
      style={{
        padding: `${layout.screenTop}px ${layout.screenX}px ${layout.screenBottom}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: layout.cardGap,
      }}
    >
      <ScreenHeader title={title} />
      <div
        style={{
          background: surface.card,
          borderRadius: radius.card,
          padding: layout.cardPadWide,
          font: '400 13.5px inherit',
          color: label.secondary,
        }}
      >
        {note}
      </div>
    </div>
  )
}
