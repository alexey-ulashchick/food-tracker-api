import { normalizeMarkdown, parseInline } from '@/lib/markdown'
import { label, surface, systemBlue } from '@/theme/tokens'
import type { ReactNode } from 'react'

// Port of CalTracker/ChatBubble.swift. Note the user bubble is systemBlue, not
// the app's orange accent — the Swift original uses SwiftUI's .blue.

const RADIUS = 20
const TAIL = 6

function renderLine(line: string, isUser: boolean): ReactNode[] {
  return parseInline(line).map((token, i) => {
    const key = `${i}-${token.kind}`
    switch (token.kind) {
      case 'bold':
        return <strong key={key}>{token.text}</strong>
      case 'italic':
        return <em key={key}>{token.text}</em>
      case 'code':
        return (
          <code
            key={key}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: '0.92em',
              background: 'rgba(255,255,255,0.1)',
              borderRadius: 4,
              padding: '0 3px',
            }}
          >
            {token.text}
          </code>
        )
      case 'link':
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noreferrer"
            style={{ color: isUser ? '#fff' : systemBlue }}
          >
            {token.text}
          </a>
        )
      default:
        return <span key={key}>{token.text}</span>
    }
  })
}

export function ChatBubble({ text, isUser }: { text: string; isUser: boolean }) {
  const lines = normalizeMarkdown(text).split('\n')

  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: 'var(--bubble-max)',
          // Swift reserves a 40pt gutter on the opposite side.
          marginLeft: isUser ? 'var(--bubble-gutter)' : 0,
          marginRight: isUser ? 0 : 'var(--bubble-gutter)',
          padding: '9px 14px',
          fontSize: 'calc(16px * var(--type))',
          lineHeight: 1.35,
          color: label.primary,
          background: isUser ? systemBlue : surface.bubble,
          borderRadius: `${RADIUS}px ${RADIUS}px ${isUser ? TAIL : RADIUS}px ${
            isUser ? RADIUS : TAIL
          }px`,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {lines.map((line, i) => (
          // Blank lines must keep their height, hence the zero-width space.
          <div key={`${i}-${line}`}>{line === '' ? '​' : renderLine(line, isUser)}</div>
        ))}
      </div>
    </div>
  )
}

/** Three dots pulsing out of phase — port of TypingBubble in the same file. */
export function TypingBubble() {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div
        style={{
          padding: '11px 14px',
          background: surface.bubble,
          borderRadius: `${RADIUS}px ${RADIUS}px ${RADIUS}px ${TAIL}px`,
          display: 'flex',
          gap: 4,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: label.secondary,
              // opacity = 0.3 + 0.7 * |sin(phase * π)| over a 1.2s cycle, with
              // each dot offset by 0.18 of the cycle.
              animation: 'typing-dot 1.2s linear infinite',
              animationDelay: `${i * 0.18 * 1.2}s`,
            }}
          />
        ))}
      </div>
    </div>
  )
}
