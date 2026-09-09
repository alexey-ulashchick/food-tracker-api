import {
  BrainIcon,
  ChatTabIcon,
  HistoryTabIcon,
  ScaleIcon,
  TodayTabIcon,
  YouTabIcon,
} from '@/theme/icons'
import type { ReactElement } from 'react'

// The one place a section of the app is declared.
//
// Both navigation surfaces read this: the phone's bottom tab bar takes the four
// entries flagged `tab` (the live tabs from RootView.swift, in that order), and
// the desktop sidebar shows all of them, grouped. Adding a section later means
// adding a row here and a route in router.tsx — the sidebar picks it up with no
// further changes, which is the point of the file.
//
// Weight and Memories are push-style sub-screens of Профиль on a phone, where
// four tabs is already the limit. A sidebar has room, so they are promoted to
// top-level entries there. Same routes either way; only the surface differs.

type IconProps = { size?: number; color?: string }

export type NavGroupId = 'main' | 'data' | 'settings'

export type NavItem = {
  to: string
  label: string
  Icon: (props: IconProps) => ReactElement
  /** Present in the phone's bottom bar. Exactly four, matching iOS. */
  tab: boolean
  group: NavGroupId
}

export const NAV: readonly NavItem[] = [
  { to: '/', label: 'Сегодня', Icon: TodayTabIcon, tab: true, group: 'main' },
  { to: '/chat', label: 'Чат', Icon: ChatTabIcon, tab: true, group: 'main' },
  { to: '/history', label: 'История', Icon: HistoryTabIcon, tab: true, group: 'main' },
  { to: '/you/weight', label: 'Вес', Icon: ScaleIcon, tab: false, group: 'data' },
  { to: '/you/memories', label: 'Память', Icon: BrainIcon, tab: false, group: 'data' },
  { to: '/you', label: 'Профиль', Icon: YouTabIcon, tab: true, group: 'settings' },
] as const

/** Sidebar group order and headings. `null` renders no heading. */
export const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId; heading: string | null }> = [
  { id: 'main', heading: null },
  { id: 'data', heading: 'Данные' },
  { id: 'settings', heading: null },
] as const

/** The four bottom-bar entries, in iOS order. */
export const TAB_ITEMS = NAV.filter((i) => i.tab)

/**
 * Whether a NavLink needs `end`, derived rather than stored.
 *
 * A link matches its path and everything below it, so an entry that another
 * entry sits underneath would stay lit while the child is open: `/you` would
 * light up on `/you/weight`, and `/` would light up on literally everything.
 *
 * It is derived because the answer differs per surface. The sidebar lists
 * Профиль alongside Вес and Память, so it needs the strict match; the tab bar
 * has no Вес entry, and iOS keeps Профиль lit while a sub-screen of it is open.
 * Storing one `end` on the item could only ever satisfy one of them.
 */
export function needsEnd(to: string, all: readonly NavItem[] = NAV): boolean {
  return to === '/' || all.some((i) => i.to !== to && i.to.startsWith(`${to}/`))
}
