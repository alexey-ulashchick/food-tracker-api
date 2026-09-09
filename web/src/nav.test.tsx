import { describe, expect, test } from 'vitest'
import { NAV, NAV_GROUPS, TAB_ITEMS, needsEnd } from './nav'

// nav.ts is the single place a section is declared, and two surfaces read it.
// These pin the invariants that make that safe to extend: the phone bar keeps
// exactly the four iOS tabs in their order, nothing is declared twice, and the
// active-link rule is derived correctly for both surfaces.

describe('the navigation table', () => {
  test('the bottom bar is exactly the four live iOS tabs, in order', () => {
    expect(TAB_ITEMS.map((i) => i.label)).toEqual(['Сегодня', 'Чат', 'История', 'Профиль'])
  })

  test('adding a section does not silently grow the phone bar', () => {
    // Вес and Память are sidebar-only. Four is the ceiling the tab bar's grid
    // and the iOS original both assume.
    expect(TAB_ITEMS).toHaveLength(4)
    expect(NAV.length).toBeGreaterThan(TAB_ITEMS.length)
  })

  test('no path is declared twice', () => {
    expect(new Set(NAV.map((i) => i.to)).size).toBe(NAV.length)
  })

  test('every entry belongs to a group the sidebar renders', () => {
    const known = new Set(NAV_GROUPS.map((g) => g.id))
    for (const item of NAV) expect(known.has(item.group)).toBe(true)
  })

  test('every group has at least one entry', () => {
    for (const group of NAV_GROUPS) {
      expect(NAV.some((i) => i.group === group.id)).toBe(true)
    }
  })
})

describe('needsEnd', () => {
  test('the root needs it, or it matches every route', () => {
    expect(needsEnd('/')).toBe(true)
  })

  test('a parent of another entry needs it', () => {
    // Профиль sits above Вес and Память in the sidebar, so /you must not stay
    // lit while one of them is open.
    expect(needsEnd('/you')).toBe(true)
  })

  test('a leaf does not', () => {
    expect(needsEnd('/chat')).toBe(false)
    expect(needsEnd('/history')).toBe(false)
    expect(needsEnd('/you/weight')).toBe(false)
  })

  test('a sibling with a shared prefix is not a child', () => {
    // /you-else is not underneath /you, however it sorts as a string.
    const table = [
      { to: '/you', label: 'a', Icon: () => <span />, tab: false, group: 'main' as const },
      { to: '/youthful', label: 'b', Icon: () => <span />, tab: false, group: 'main' as const },
    ]
    expect(needsEnd('/you', table)).toBe(false)
  })
})
