// Keeps the app shell the size of what the user can actually see.
//
// iOS shrinks only the visual viewport when the software keyboard opens — the
// layout viewport stays full height. `position: fixed; bottom: 0` is anchored to
// the layout viewport, so a bottom bar ends up behind the keyboard, and the
// scroll-to-focus that follows strands it in the middle of the screen. That is
// what the tab bar and the chat composer were both doing.
//
// Sizing the shell from visualViewport instead lets both be ordinary elements in
// a flex column rather than fixed overlays guessing where the bottom is.
//
// `data-keyboard` on <html> follows SwiftUI, where the keyboard simply covers the
// tab bar: it hides while typing instead of stealing 52px above the keys.

/** Less height lost than this is browser chrome collapsing, not a keyboard. */
const KEYBOARD_MIN_PX = 120

export function trackViewport(): () => void {
  const vv = window.visualViewport
  const root = document.documentElement

  const apply = () => {
    const height = vv?.height ?? window.innerHeight
    root.style.setProperty('--app-height', `${height}px`)

    if (window.innerHeight - height > KEYBOARD_MIN_PX) root.dataset.keyboard = 'open'
    else delete root.dataset.keyboard

    // The document is overflow:hidden and has nothing to scroll, but iOS scrolls
    // it anyway when it decides a focused field needs revealing — which drags the
    // fixed shell out of alignment with the screen. Put it back.
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }

  apply()
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('orientationchange', apply)

  return () => {
    vv?.removeEventListener('resize', apply)
    vv?.removeEventListener('scroll', apply)
    window.removeEventListener('orientationchange', apply)
  }
}
