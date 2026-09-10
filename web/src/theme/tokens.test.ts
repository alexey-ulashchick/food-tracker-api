import { describe, expect, test, vi } from 'vitest'
import { resolveColor, surface, withAlpha } from './tokens'

// Colour reaches the app two ways, and both are pinned here.
//
// CSS and inline styles get `var(--c-…)` and let the cascade pick the theme.
// Canvas cannot do that — strokeStyle and createConicGradient need a real
// colour — so the ring and the pie call resolveColor to read the literal back
// out. A regression there is silent: canvas ignores a colour it cannot parse and
// paints with whatever was set before.

describe('withAlpha', () => {
  test('works on a custom property, which parsing a hex could not', () => {
    // The reason it is color-mix: by the time this runs, the value is
    // `var(--c-accent)` and the literal is not available to JS.
    expect(withAlpha('var(--c-accent)', 0.18)).toBe(
      'color-mix(in srgb, var(--c-accent) 18%, transparent)',
    )
  })

  test('still works on a plain colour', () => {
    expect(withAlpha('#FF9500', 0.4)).toBe('color-mix(in srgb, #FF9500 40%, transparent)')
  })

  test('the whole and zero ends are expressed, not special-cased away', () => {
    expect(withAlpha('#000000', 1)).toContain('100%')
    expect(withAlpha('#000000', 0)).toContain('0%')
  })
})

describe('resolveColor', () => {
  test('reads the literal a custom property holds', () => {
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => (name === '--c-track' ? ' rgba(1,2,3,0.5) ' : ''),
    }))
    // Trimmed: getPropertyValue keeps the authored whitespace, and canvas would
    // reject the padded string.
    expect(resolveColor(surface.track)).toBe('rgba(1,2,3,0.5)')
    vi.unstubAllGlobals()
  })

  test('passes a plain colour straight through', () => {
    expect(resolveColor('#FF3B30')).toBe('#FF3B30')
    expect(resolveColor('rgba(0,0,0,1)')).toBe('rgba(0,0,0,1)')
  })

  test('returns the input when the property is not set', () => {
    // What jsdom does: no stylesheets, so every lookup is empty. Returning the
    // var() text keeps the caller from painting with an empty string.
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    expect(resolveColor('var(--c-nope)')).toBe('var(--c-nope)')
    vi.unstubAllGlobals()
  })

  test('ignores anything that is not a bare var() reference', () => {
    // A fallback or a nested expression is not something canvas can be handed,
    // and half-resolving it would be worse than leaving it alone.
    expect(resolveColor('var(--a, #fff)')).toBe('var(--a, #fff)')
    expect(resolveColor('color-mix(in srgb, var(--a) 50%, transparent)')).toBe(
      'color-mix(in srgb, var(--a) 50%, transparent)',
    )
  })
})

describe('the token layer', () => {
  test('every colour token is a custom property, so the theme can switch it', () => {
    // A literal here would be a colour the light theme cannot reach.
    for (const [name, value] of Object.entries(surface)) {
      expect(value, name).toMatch(/^var\(--c-/)
    }
  })
})
