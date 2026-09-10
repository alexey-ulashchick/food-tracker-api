import { label } from '@/theme/tokens'
import type { ReactNode } from 'react'

// Port of CalTracker/ScreenHeader.swift — the bespoke 32pt title used on every
// top-level tab. The Swift version exists because iOS 17's system large title
// adds ~80pt of implicit top padding; on the web there is no such quirk, so
// this is simply the same type scale.

type Props = {
  title: string
  subtitle?: string
  trailing?: ReactNode
}

export function ScreenHeader({ title, subtitle, trailing }: Props) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <h1
          style={{
            fontWeight: 700,
            fontSize: 'calc(32px * var(--type))',
            lineHeight: 1.1,
            margin: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </h1>
        {subtitle ? (
          <span
            className="tnum"
            style={{
              fontWeight: 500,
              fontSize: 'calc(13px * var(--type))',
              color: label.secondary,
            }}
          >
            {subtitle}
          </span>
        ) : null}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {trailing}
      </div>
    </header>
  )
}
