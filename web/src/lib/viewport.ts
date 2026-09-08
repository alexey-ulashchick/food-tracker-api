// Keeps the app shell the size of what the user can actually see.
//
// iOS shrinks only the visual viewport when the software keyboard opens — the
// layout viewport stays full height. `position: fixed; bottom: 0` is anchored to
// the layout viewport, so a bottom bar ends up behind the keyboard, and the
// scroll-to-focus that follows strands it in the middle of the screen. That is
// what the tab bar and the chat composer were both doing.
//
// So the shell shrinks to the visual viewport while the keyboard is up, and the
// bar is an ordinary flex child rather than a fixed overlay guessing where the
// bottom is. At rest the shell is height:100% — see index.css for why nothing is
// measured there. Nothing is position:fixed either: extra compositing layers are
// what made iOS stop repainting the card backgrounds and the text.
//
// `data-keyboard` on <html> follows SwiftUI, where the keyboard simply covers the
// tab bar: it hides while typing instead of stealing 52px above the keys.

/** Less height lost than this is browser chrome collapsing, not a keyboard. */
const KEYBOARD_MIN_PX = 120

/**
 * The layout viewport, for telling a keyboard apart from browser chrome.
 *
 * Not used to size the shell at rest: that is `height: 100%` in CSS, which is
 * the layout viewport by definition. Every measured stand-in tried here —
 * innerHeight, clientHeight, the two combined, plus 100dvh — came out short of
 * the screen on iOS and left the tab bar hanging above the bottom edge.
 */
function layoutHeight(): number {
  return Math.max(window.innerHeight, document.documentElement.clientHeight)
}

export function trackViewport(): () => void {
  const vv = window.visualViewport
  const root = document.documentElement
  let published = -1

  const apply = () => {
    const layout = layoutHeight()
    const visual = Math.round(vv?.height ?? layout)
    // The keyboard shrinks only the visual viewport, so the gap between the two
    // is what reveals it.
    const keyboardOpen = layout - visual > KEYBOARD_MIN_PX

    // Only on a real change. visualViewport's scroll event fires continuously
    // during a drag, and setting a custom property on <html> invalidates style
    // for the entire tree — cheap to skip, expensive to repeat.
    if (visual !== published) {
      published = visual
      root.style.setProperty('--app-height', `${visual}px`)
    }

    if (keyboardOpen) root.dataset.keyboard = 'open'
    else delete root.dataset.keyboard

    // The document is overflow:hidden and has nothing to scroll, but iOS scrolls
    // it anyway when it decides a focused field needs revealing — which drags the
    // shell out of alignment with the screen. Put it back.
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
