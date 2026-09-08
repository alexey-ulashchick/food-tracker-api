import { describe, expect, test } from 'vitest'

// The `font` shorthand ends in font-family, and CSS-wide keywords are not valid
// as a component of a shorthand — only as an entire declaration. So a shorthand
// naming `inherit` as its family parses as nothing at all: the browser drops the
// whole declaration and the element keeps whatever size it inherited.
//
// This shipped in 103 places and went unnoticed because the discarded sizes were
// close enough to the 16px default to look merely "off". Page titles gave it
// away — 32px rendering at the browser's default h1 size.
//
// Use fontWeight/fontSize/lineHeight separately. `font: 'inherit'` alone is fine,
// and so is a shorthand naming a real family.

/** A CSS-wide keyword sitting where the family belongs, i.e. after other parts. */
const INVALID = /font:\s*'[^']+\s+(inherit|initial|unset|revert)'/g

// Read through Vite rather than node:fs — the web project deliberately has no
// Node types, and browser sources should not be able to reach for them.
const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('the font shorthand', () => {
  test('never puts a CSS-wide keyword where the family belongs', () => {
    const offenders = Object.entries(sources)
      // This file quotes the broken form in its own explanation.
      .filter(([path]) => !path.endsWith('fontShorthand.test.ts'))
      .flatMap(([path, text]) => (text.match(INVALID) ?? []).map((m) => `${path}: ${m}`))

    expect(offenders).toEqual([])
  })

  test('the scan actually catches the broken form', () => {
    expect("style={{ font: '600 14px inherit' }}".match(INVALID)).not.toBeNull()
    expect("style={{ font: 'inherit' }}".match(INVALID)).toBeNull()
    expect("style={{ font: '600 13px system-ui' }}".match(INVALID)).toBeNull()
  })
})
