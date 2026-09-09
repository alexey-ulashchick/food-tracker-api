import type { ReactNode } from 'react'

// The root of every scrolling screen: Today, History, You, Memories, Weight.
//
// It exists so the page's width, padding and card gap live in ONE place —
// `.page` in index.css — instead of five identical inline copies. Inline
// padding cannot be changed by a media query, so a desktop layout had no way
// in until this moved to a class.
//
// Deliberately dumb: no `layout` or `variant` prop. A screen that wants its
// cards two-up adds its own grid class around them; a component that takes a
// layout enum is a config object wearing a component's clothes.
//
// Chat is not built on this — it owns its own scroller so the header, macro
// strip and composer can stay pinned while only the transcript moves.

export function Page({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>
}
