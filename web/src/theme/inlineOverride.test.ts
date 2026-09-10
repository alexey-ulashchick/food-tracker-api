import { describe, expect, test } from 'vitest'

// Guards the one trap this codebase is uniquely exposed to.
//
// Almost every element here carries an inline `style={{}}`, and an inline
// declaration beats any class rule regardless of the class's specificity. So a
// layout class whose property is ALSO set inline on the same element does
// nothing — at every width, silently, with nothing thrown and no visual clue
// until someone opens a wide window and wonders why the grid never appeared.
//
// This was not hypothetical: the first pass at the desktop layout shipped
// `.meal-text { flex-direction: row }` onto an element whose inline style said
// `flexDirection: 'column'`, and `.memory-grid { display: grid }` onto one
// declaring `display: 'flex'`.
//
// The scan reads sources through import.meta.glob rather than node:fs, because
// web/tsconfig.json exposes only vite/client types. It deliberately does not
// read index.css: vitest's `vitest:css-disable` plugin rewrites every CSS import
// to an empty string, so a `?raw` import of it would be permanently, silently
// blank. The property list below is therefore maintained by hand.

/** Properties each layout class owns, and so must not be set inline with it. */
const CLASS_OWNS: Record<string, string[]> = {
  page: ['padding', 'display', 'flexDirection', 'gap'],
  'app-shell': ['height', 'maxWidth', 'margin', 'display', 'flexDirection', 'position'],
  'shell-body': ['flex', 'minWidth', 'minHeight', 'display', 'flexDirection'],
  'card-row': ['display', 'gap', 'gridTemplateColumns'],
  'card-row--today': ['gridTemplateColumns'],
  'card-block': ['display', 'flexDirection', 'gap', 'minWidth'],
  'chat-measure': ['width', 'maxWidth', 'margin'],
  'weight-split': ['display', 'flexDirection', 'gap'],
  'meal-text': ['display', 'flexDirection', 'gap', 'minWidth'],
  'memory-grid': ['display', 'flexDirection', 'gap'],
  'metrics-split': ['display', 'gridTemplateColumns'],
  'meal-type': ['width'],
  'meal-time': ['width'],
  'meal-macros': ['width'],
  'meal-name': ['flex', 'minWidth'],
  'meal-meta': ['flex'],
  'nav-item': ['display', 'alignItems', 'gap', 'height', 'padding', 'borderRadius'],
  'outer-frame': ['height', 'overflowY'],
}

/**
 * Known-good exceptions: an inline value that is meant to beat the class.
 * Keyed `file:class`, listing the properties allowed to shadow it.
 */
const ALLOWED: Record<string, string[]> = {
  // Login wants a form-width column, not the 1180px content column .page gives
  // every screen above the breakpoint.
  'screens/Login.tsx:page': ['maxWidth', 'margin'],
}

const sources = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true })

/** `className="a b"` together with the `style={{…}}` on the same element. */
const TAG = /className="([^"]+)"([\s\S]*?)(?=>)/g
const STYLE = /style=\{\{([\s\S]*?)\}\}/
const PROP = /([A-Za-z]+)\s*:/g

function findConflicts(path: string, src: string): string[] {
  const out: string[] = []
  for (const tag of src.matchAll(TAG)) {
    const style = STYLE.exec(tag[2] ?? '')
    if (!style) continue

    const inline = new Set([...(style[1] ?? '').matchAll(PROP)].map((m) => m[1]))
    for (const name of (tag[1] ?? '').split(/\s+/)) {
      const owned = CLASS_OWNS[name]
      if (!owned) continue

      const key = `${path.replace(/^.*?web\/src\//, '').replace(/^\.\.\//, '')}:${name}`
      const allowed = new Set(ALLOWED[key] ?? [])
      const shadowed = owned.filter((p) => inline.has(p) && !allowed.has(p))
      if (shadowed.length > 0) out.push(`.${name} shadowed by inline ${shadowed.join(', ')}`)
    }
  }
  return out
}

describe('layout classes are not shadowed by inline styles', () => {
  test('the scan reaches the real sources', () => {
    const paths = Object.keys(sources)
    expect(paths.length).toBeGreaterThan(10)
    expect(paths.some((p) => p.endsWith('screens/Today.tsx'))).toBe(true)
    // If CSS-style blanking ever applied to .tsx too, this would be empty.
    expect(String(sources['../screens/Today.tsx'])).toContain('className="meal-text"')
  })

  test('the scan catches a conflict when there is one', () => {
    const broken = `<div className="meal-text" style={{ flexDirection: 'column' }}>`
    expect(findConflicts('screens/Fake.tsx', broken)).toEqual([
      '.meal-text shadowed by inline flexDirection',
    ])
  })

  test('and lets a declared exception through', () => {
    const ok = `<div className="page" style={{ maxWidth: 'var(--form-max)' }}>`
    expect(findConflicts('screens/Login.tsx', ok)).toEqual([])
  })

  test.each(Object.keys(sources))('%s', (path) => {
    expect(findConflicts(path, String(sources[path]))).toEqual([])
  })
})
