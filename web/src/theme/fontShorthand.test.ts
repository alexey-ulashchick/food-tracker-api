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

/** A CSS-wide keyword sitting where the family belongs, i.e. after other parts.
 *  Both quoted and template forms — the first sweep missed the templates, and
 *  one of them was the 40px calorie figure. */
const INVALID = /font:\s*(['`])[^'`]+\s+(inherit|initial|unset|revert)\1/g

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
    expect('style={{ font: `700 ${size}px inherit` }}'.match(INVALID)).not.toBeNull()
    expect("style={{ font: 'inherit' }}".match(INVALID)).toBeNull()
    expect("style={{ font: '600 13px system-ui' }}".match(INVALID)).toBeNull()
  })
})

// Every inline size is written `calc(Npx * var(--type))` so one variable can
// rescale the whole app: phone point sizes read as oversized at desktop viewing
// distance, and there is no other way to reach ~110 inline declarations at once.
//
// A bare `fontSize: 14` is therefore a size that silently ignores the scale.
// It renders fine, so nothing catches it but this.

/** `fontSize: 14` / `fontSize: 14.5` — a raw number, not a calc(). */
const UNSCALED = /fontSize: \d+(\.\d+)?(?=[,\s}\n])/g

describe('the type scale', () => {
  test('no inline font size opts out of it', () => {
    const offenders = Object.entries(sources)
      // This file names the unscaled form to explain it.
      .filter(([path]) => !path.endsWith('fontShorthand.test.ts'))
      .flatMap(([path, text]) => (text.match(UNSCALED) ?? []).map((m) => `${path}: ${m}`))

    expect(offenders).toEqual([])
  })

  test('the scan tells a raw size from a scaled one', () => {
    expect('style={{ fontSize: 14.5 }}'.match(UNSCALED)).not.toBeNull()
    expect('style={{ fontSize: 32, margin: 0 }}'.match(UNSCALED)).not.toBeNull()
    expect("style={{ fontSize: 'calc(14.5px * var(--type))' }}".match(UNSCALED)).toBeNull()
    // Relative and computed forms carry the scale from their context.
    expect("style={{ fontSize: '0.92em' }}".match(UNSCALED)).toBeNull()
    expect('style={{ fontSize: `calc(${size}px * var(--type))` }}'.match(UNSCALED)).toBeNull()
  })
})
