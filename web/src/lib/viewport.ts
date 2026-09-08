// Keeps the app shell the size of what the user can actually see.
//
// iOS shrinks only the visual viewport when the software keyboard opens — the
// layout viewport stays full height. `position: fixed; bottom: 0` is anchored to
// the layout viewport, so a bottom bar ends up behind the keyboard, and the
// scroll-to-focus that follows strands it in the middle of the screen. That is
// what the tab bar and the chat composer were both doing.
//
// Publishing the visual viewport height instead lets the shell be a plain block
// of exactly the visible height, with the bar as an ordinary flex child. Nothing
// is position:fixed: extra compositing layers are what made iOS stop repainting
// the card backgrounds and the text.
//
// `data-keyboard` on <html> follows SwiftUI, where the keyboard simply covers the
// tab bar: it hides while typing instead of stealing 52px above the keys.

/** Less height lost than this is browser chrome collapsing, not a keyboard. */
const KEYBOARD_MIN_PX = 120

/**
 * The height the shell fills: what the browser reports, uncorrected.
 *
 * A previous attempt added the top safe area back, on the theory that iOS was
 * understating the viewport. The readout from the device looked conclusive —
 *
 *   inner 844   client 844   visual 844   screen 912   inset-t 68   inset-b 34
 *
 * with 912 − 844 exactly the top inset. It was wrong: at 912 the tab bar was
 * clipped off the bottom of the screen. So 844 is the real height, the app was
 * filling the screen all along, and screen.height is the value that cannot be
 * trusted here. Nothing is computed from it.
 */
function reportedHeight(): number {
  return Math.max(window.innerHeight, document.documentElement.clientHeight)
}

export function trackViewport(): () => void {
  const vv = window.visualViewport
  const root = document.documentElement
  let published = -1

  const apply = () => {
    const frame = reportedHeight()
    const visual = Math.round(vv?.height ?? frame)
    // The keyboard shrinks only the visual viewport, so the gap between the two
    // is what reveals it.
    const keyboardOpen = frame - visual > KEYBOARD_MIN_PX
    const height = keyboardOpen ? visual : frame

    // Only on a real change. visualViewport's scroll event fires continuously
    // during a drag, and setting a custom property on <html> invalidates style
    // for the entire tree — cheap to skip, expensive to repeat.
    if (height !== published) {
      published = height
      root.style.setProperty('--app-height', `${height}px`)

      if (keyboardOpen) root.dataset.keyboard = 'open'
      else delete root.dataset.keyboard
    }

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
