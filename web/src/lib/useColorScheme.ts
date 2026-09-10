import { useSyncExternalStore } from 'react'

// The OS colour scheme, for canvas only.
//
// Everything else follows the theme without asking: the colour tokens are
// custom properties, so a stylesheet flips them and the inline styles that read
// them re-compute on their own. Canvas is the exception — it takes a real colour
// string and keeps the pixels until something redraws them. So this exists to be
// a dependency, not to be branched on.
//
// Unlike the layout breakpoint, the condition here is a name rather than a
// tunable number, so restating it in JS carries no drift risk: there is no
// `1024` to disagree about. The media query in index.css and the query string
// below express the same fixed fact.

const QUERY = '(prefers-color-scheme: light)'

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null
}

function subscribe(onStoreChange: () => void): () => void {
  const mq = query()
  if (!mq) return () => {}
  mq.addEventListener('change', onStoreChange)
  return () => mq.removeEventListener('change', onStoreChange)
}

/** 'light' | 'dark' — a value to key a redraw on, not a palette to pick with. */
export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    subscribe,
    () => (query()?.matches ? 'light' : 'dark'),
    () => 'dark',
  )
}
