import { useCallback, useEffect, useRef, useState } from 'react'

// Reports an element's content width, kept current by a ResizeObserver.
//
// The two SVG charts need their width as a NUMBER, not as a CSS value: it goes
// into the viewBox and into the band-scale arithmetic that places every bar and
// tick. That is the one category of thing a custom property cannot carry, which
// is why this hook exists at all when the rest of the desktop work is CSS.
//
// A ResizeObserver rather than a window `resize` listener, deliberately. A
// chart's width also changes when the sidebar mounts, when the error banner
// wraps to a second line, and when a scrollbar appears — none of which fire
// `resize`. The observer sees all of them because it watches the box itself.

export function useElementWidth<T extends Element>(): [(node: T | null) => void, number] {
  // 0 means "not measured yet", which callers render as nothing. Seeding a
  // plausible-looking width instead would draw one frame of a chart laid out
  // for a viewport that may not exist.
  const [width, setWidth] = useState(0)
  const observed = useRef<T | null>(null)
  const observer = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    return () => observer.current?.disconnect()
  }, [])

  const ref = useCallback((node: T | null) => {
    if (observed.current === node) return
    observed.current = node

    observer.current?.disconnect()
    if (!node) return

    // Built here rather than in an effect so the first measurement lands in the
    // same commit the element mounts in, not a frame later.
    const next = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      // contentRect excludes padding and border, which is what the viewBox
      // wants: the SVG fills the content box. No equality guard — React bails
      // out of a setState that is Object.is-equal to the current value, and a
      // rounded number always is.
      setWidth(Math.round(entry.contentRect.width))
    })
    next.observe(node)
    observer.current = next

    // ResizeObserver fires its first callback asynchronously. Reading the box
    // now avoids a frame of width 0 on mount.
    const initial = Math.round(node.getBoundingClientRect().width)
    if (initial > 0) setWidth(initial)
  }, [])

  return [ref, width]
}
