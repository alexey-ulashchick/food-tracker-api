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

/** `'#fff'`, `'#FF9500'`, `'rgba(…)'`, `'rgb(…)'` — a colour spelled out. */
const LITERAL = /'#[0-9A-Fa-f]{3,8}'|'rgba?\([^')]*\)'/g

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
    expect("background: '#1C1C1C'".match(LITERAL)).toEqual(["'#1C1C1C'"])
    expect("color: 'rgba(255,255,255,0.06)'".match(LITERAL)).toEqual(["'rgba(255,255,255,0.06)'"])
    expect("color: 'rgb(0, 145, 234)'".match(LITERAL)).toEqual(["'rgb(0, 145, 234)'"])
    // What the app should say instead.
    expect('background: surface.card'.match(LITERAL)).toBeNull()
    expect("background: 'var(--c-card)'".match(LITERAL)).toBeNull()
  })

  test('no component spells a colour out', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !(rel(path) in ALLOWED))
      .flatMap(([path, text]) => (text.match(LITERAL) ?? []).map((m) => `${rel(path)}: ${m}`))

    expect(offenders).toEqual([])
  })

  test('every exception is still needed', () => {
    // An allowance that has outlived its literal is a rule nobody is following.
    for (const [path, reason] of Object.entries(ALLOWED)) {
      const text = sources[`/src/${path}`]
      expect(text, `${path} is listed but does not exist`).toBeDefined()
      expect(text?.match(LITERAL), `${path}: ${reason}`).not.toBeNull()
    }
  })
})
