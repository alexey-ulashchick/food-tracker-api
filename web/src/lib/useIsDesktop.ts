import { useSyncExternalStore } from 'react'

// Which layout tier we are in, asked of CSS rather than restated in JS.
//
// index.css declares `--desktop: 0`, and its one media query flips it to 1.
// This reads the computed value. So the breakpoint exists exactly once in the
// repository: there is no second copy here to drift from it, and no test is
// needed to prove the two agree, because there is no "two".
//
// Only one thing needs this — the shell choosing between a sidebar and a tab
// bar. Everything else that changes with width is a CSS value, and a custom
// property already carries those straight through the inline styles the app is
// built from. Resist adding consumers: a component that takes a pixel size from
// here instead of a var() has moved layout back into JS.
//
// In jsdom there are no stylesheets and no media-query evaluation, so the probe
// reads '' and every unit test gets the phone shell without stubbing anything.

const PROBE = '--desktop'

function readTier(): boolean {
  if (typeof document === 'undefined') return false
  return getComputedStyle(document.documentElement).getPropertyValue(PROBE).trim() === '1'
}

function subscribe(onStoreChange: () => void): () => void {
  // Coalesced to one read per frame: a drag-resize fires `resize` continuously,
  // and each getComputedStyle is a forced style recalc. React compares the new
  // snapshot with Object.is, so the common case — a resize that does not cross
  // the breakpoint — costs one read and no re-render.
  let frame = 0
  const queue = () => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      onStoreChange()
    })
  }

  window.addEventListener('resize', queue)
  window.addEventListener('orientationchange', queue)
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame)
    window.removeEventListener('resize', queue)
    window.removeEventListener('orientationchange', queue)
  }
}

export function useIsDesktop(): boolean {
  // No memo cache behind getSnapshot. It would have to be module-level to
  // survive re-renders, and a module-level cache outlives the document — which
  // makes the first render after any environment change serve a stale answer.
  // readTier is deterministic and there is one consumer, so reading it is
  // cheaper than being wrong.
  return useSyncExternalStore(subscribe, readTier, () => false)
}
