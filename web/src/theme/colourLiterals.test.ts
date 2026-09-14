import { describe, expect, test } from 'vitest'

// A colour written as a literal in a component is a colour the light theme
// cannot reach. It renders perfectly well — that is the problem: nothing fails,
// the app simply keeps a black-on-black hairline or an invisible pale-green arc
// when the OS switches. There is no runtime signal at all, so the check has to
// be on the source.
//
// The rule: components take colour from theme/tokens.ts, which holds
// `var(--c-…)`; the literals live once each in the --c- block in index.css.
//
// Read through Vite rather than node:fs — the web project deliberately has no
// Node types. index.css itself is NOT scanned: vitest's `vitest:css-disable`
// plugin rewrites CSS imports to an empty string, so a `?raw` import of it would
// be permanently, silently blank.

/**
 * Any quoted string or template literal, which is where a colour can hide.
 *
 * The first version of this scan required the colour to BE the whole quoted
 * string. Four kinds of literal walked straight past it, and every one of them
 * was a real light-theme bug:
 *
 *   boxShadow: '0 0 0 0.5px rgba(255,255,255,0.14)'   — colour inside a value
 *   stroke="rgba(255,255,255,0.22)"                    — double quotes
 *   tint="#BF5AF2"                                     — double quotes
 *   `0 2px 6px rgba(0,0,0,0.5)`                        — template literal
 *
 * A white ring on a card that turns white draws nothing, and a white scrub line
 * on a white page draws nothing. Both shipped. Comments are exempt for free,
 * because a comment is not a quoted string — which is what lets the values be
 * documented where they are defined.
 */
const STRINGS = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g

/** `#fff`, `#FF9500`, `rgb(…)`, `rgba(…)` — a colour spelled out. */
const COLOUR = /#[0-9A-Fa-f]{3,8}\b|\brgba?\([^)]*\)/

/** Every colour hiding in a string in this source. */
function literalsIn(text: string): string[] {
  return (text.match(STRINGS) ?? []).filter((s) => COLOUR.test(s))
}

/**
 * Files allowed to name a colour, each for a stated reason.
 *
 * Not a convenience list: every entry is a place where the value genuinely does
 * not vary by theme, or where the literal IS the fixture under test.
 */
const ALLOWED: Record<string, string> = {
  'components/ring/MacroRing.test.tsx': 'stubs the dark literals jsdom has no stylesheet for',
  'components/ring/ringColor.test.ts': 'colour maths fixtures, deliberately not theme tokens',
  'theme/tokens.test.ts': 'asserts on literal inputs and outputs',
  'components/ring/ringColor.ts': 'builds a CSS colour out of computed numbers; that IS its job',
  'components/ring/MacroRing.tsx':
    'canvas cannot read a custom property, and the head shadow alpha is computed per frame',
}

// This file quotes the offending forms to explain them and is not on the list,
// because Vite leaves the importing module out of its own glob.

// Root-relative, not `../**`: a relative glob resolves same-directory files to
// `./name.ts` and everything else to `../dir/name.ts`, so the keys would not
// share a shape to match an allowlist against.
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** `/src/screens/Today.tsx` → `screens/Today.tsx`. */
const rel = (path: string) => path.replace(/^\/src\//, '')

describe('colour literals', () => {
  test('the scan reaches the real sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
    expect(sources['/src/theme/tokens.ts']).toContain('var(--c-card)')
  })

  test('the scan recognises the forms it is looking for', () => {
    expect(literalsIn("background: '#1C1C1C'")).toEqual(["'#1C1C1C'"])
    expect(literalsIn("color: 'rgba(255,255,255,0.06)'")).toEqual(["'rgba(255,255,255,0.06)'"])
    expect(literalsIn("color: 'rgb(0, 145, 234)'")).toEqual(["'rgb(0, 145, 234)'"])
  })

  test('it catches the four forms that used to walk past it', () => {
    // Each of these shipped a colour that cannot follow the theme.
    expect(literalsIn("boxShadow: '0 0 0 0.5px rgba(255,255,255,0.14)'")).toHaveLength(1)
    expect(literalsIn('stroke="rgba(255,255,255,0.22)"')).toHaveLength(1)
    expect(literalsIn('tint="#BF5AF2"')).toHaveLength(1)
    expect(literalsIn('boxShadow: `0 2px 6px rgba(0,0,0,0.5)`')).toHaveLength(1)
  })

  test('it leaves alone what the app should say instead', () => {
    expect(literalsIn('background: surface.card')).toEqual([])
    expect(literalsIn("background: 'var(--c-card)'")).toEqual([])
    expect(literalsIn('boxShadow: `0 4px 16px ${shadow}`')).toEqual([])
    expect(literalsIn('tint={memoryTint}')).toEqual([])
  })

  test('a comment may name the value it is explaining', () => {
    // Otherwise the tokens could not be documented where they are defined.
    expect(literalsIn('// iOS teal is #30b0c7 in the dark variant')).toEqual([])
  })

  test('no component spells a colour out', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !(rel(path) in ALLOWED))
      .flatMap(([path, text]) => literalsIn(text).map((m) => `${rel(path)}: ${m}`))

    expect(offenders).toEqual([])
  })

  test('every exception is still needed', () => {
    // An allowance that has outlived its literal is a rule nobody is following.
    for (const [path, reason] of Object.entries(ALLOWED)) {
      const text = sources[`/src/${path}`]
      expect(text, `${path} is listed but does not exist`).toBeDefined()
      expect(literalsIn(text ?? ''), `${path}: ${reason}`).not.toEqual([])
    }
  })
})
