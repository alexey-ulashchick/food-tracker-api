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

/**
 * What the browser reports about the viewport, for the Профиль footer.
 *
 * The tab bar sat above the physical bottom edge through two rounds of fixes
 * aimed at the wrong cause, because the same symptom has two incompatible
 * explanations that need opposite corrections: either the shell is shorter than
 * the screen, or viewport-fit=cover is not in effect and the safe-area insets
 * read as zero. These numbers tell the two apart at a glance instead of by
 * inference from a photo.
 */
export function viewportMetrics(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const inset = (name: string) => style.getPropertyValue(name).trim() || '—'
  const root = document.getElementById('root')

  return {
    inner: String(window.innerHeight),
    client: String(document.documentElement.clientHeight),
    visual: String(Math.round(window.visualViewport?.height ?? 0)),
    screen: String(window.screen?.height ?? 0),
    root: String(root?.getBoundingClientRect().height ?? 0),
    'inset-t': inset('--sat'),
    'inset-b': inset('--sab'),
    standalone: window.matchMedia('(display-mode: standalone)').matches ? 'да' : 'нет',
  }
}

/** Less height lost than this is browser chrome collapsing, not a keyboard. */
const KEYBOARD_MIN_PX = 120

/**
 * The layout viewport — the whole screen under viewport-fit=cover, and notably
 * NOT affected by the keyboard, which only shrinks the visual viewport.
 *
 * Measured rather than expressed in CSS. Both `height: 100%` and `100dvh` have
 * now been tried and both left the tab bar short of the bottom edge on iOS, so
 * whatever those resolve against here is not the screen. Two sources are read
 * because iOS has been known to under-report either one depending on version and
 * display mode; the larger is the one that spans the screen.
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
    const visual = Math.round(window.visualViewport?.height ?? layout)
    // The keyboard shrinks only the visual viewport, so the gap between the two
    // is what reveals it.
    const keyboardOpen = layout - visual > KEYBOARD_MIN_PX
    const height = keyboardOpen ? visual : layout

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
