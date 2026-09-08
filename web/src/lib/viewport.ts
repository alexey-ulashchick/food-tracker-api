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
    corr: String(heightCorrection()),
    standalone: window.matchMedia('(display-mode: standalone)').matches ? 'да' : 'нет',
  }
}

/** Less height lost than this is browser chrome collapsing, not a keyboard. */
const KEYBOARD_MIN_PX = 120

/** Reads a px-valued custom property off <html>. */
function cssPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  return Number.parseFloat(raw) || 0
}

/**
 * How much every height iOS reports understates the screen.
 *
 * On this device, installed to the home screen, the readout is
 *
 *   inner 844   client 844   visual 844   screen 912   inset-t 68   inset-b 34
 *
 * and 912 − 844 is exactly the top inset. The webview does cover the screen —
 * it reports a bottom inset for the home indicator, which it would not do if it
 * stopped short — but every height it exposes is short by the top safe area.
 * All three agree, which is why taking max() of two of them changed nothing, and
 * why height:100% and 100dvh both left the tab bar hanging: they resolve against
 * that same understated viewport.
 *
 * Applied only when the arithmetic actually lines up (reported + inset fits
 * within the screen) and only in standalone, which is where this was measured.
 * In a browser tab the reported height is honest and moves with the chrome, so
 * correcting it would push the bar under the toolbar instead.
 */
function heightCorrection(): number {
  if (!window.matchMedia('(display-mode: standalone)').matches) return 0

  const reported = Math.max(window.innerHeight, document.documentElement.clientHeight)
  const screenHeight = window.screen?.height ?? 0
  const insetTop = cssPx('--sat')

  return screenHeight > 0 && insetTop > 0 && reported + insetTop <= screenHeight ? insetTop : 0
}

export function trackViewport(): () => void {
  const vv = window.visualViewport
  const root = document.documentElement
  let published = -1

  const apply = () => {
    // The same correction goes on both: the visual viewport is reported in the
    // same understated coordinates, so leaving it raw would float the composer
    // a safe-area above the keys.
    const correction = heightCorrection()
    const frame = Math.max(window.innerHeight, document.documentElement.clientHeight) + correction
    const visual = Math.round(vv?.height ?? frame) + (vv ? correction : 0)
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
