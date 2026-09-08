import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { trackViewport } from './viewport'

// The shell's height comes from the visual viewport, and the keyboard flag comes
// from the gap between that and the layout viewport. Both are what keep the tab
// bar and the composer off the keyboard, so the threshold is pinned here.

type Listener = () => void

function stubVisualViewport(height: number) {
  const listeners = new Map<string, Set<Listener>>()
  const vv = {
    height,
    addEventListener(type: string, fn: Listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn)
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
  vi.stubGlobal('visualViewport', vv)
  return vv
}

const LAYOUT_HEIGHT = 844

beforeEach(() => {
  vi.stubGlobal('innerHeight', LAYOUT_HEIGHT)
  vi.stubGlobal('scrollTo', vi.fn())
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.keyboard
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('trackViewport', () => {
  test('publishes the layout viewport height as --app-height at rest', () => {
    stubVisualViewport(LAYOUT_HEIGHT)
    const stop = trackViewport()

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')
    stop()
  })

  test('takes the larger of innerHeight and clientHeight', () => {
    // iOS has under-reported one or the other depending on version and display
    // mode, and the one that spans the screen is the larger.
    vi.stubGlobal('innerHeight', 700)
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 844,
      configurable: true,
    })
    stubVisualViewport(844)

    const stop = trackViewport()
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')

    stop()
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 0,
      configurable: true,
    })
  })

  test('flags the keyboard once the viewport loses more than browser chrome', () => {
    const vv = stubVisualViewport(LAYOUT_HEIGHT)
    const stop = trackViewport()

    expect(document.documentElement.dataset.keyboard).toBeUndefined()

    // A keyboard takes roughly a third of the screen.
    vv.height = 508
    vv.emit('resize')
    expect(document.documentElement.dataset.keyboard).toBe('open')
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('508px')

    vv.height = LAYOUT_HEIGHT
    vv.emit('resize')
    expect(document.documentElement.dataset.keyboard).toBeUndefined()
    stop()
  })

  test('a collapsing browser toolbar is not a keyboard, and does not shorten the shell', () => {
    const vv = stubVisualViewport(LAYOUT_HEIGHT)
    const stop = trackViewport()

    vv.height = LAYOUT_HEIGHT - 100
    vv.emit('resize')

    expect(document.documentElement.dataset.keyboard).toBeUndefined()
    // At rest the shell spans the layout viewport, not the visual one. Following
    // the visual viewport here is what left the tab bar short of the bottom edge.
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')
    stop()
  })

  test('puts the document back when iOS scrolls it to reveal a focused field', () => {
    const vv = stubVisualViewport(LAYOUT_HEIGHT)
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    vi.stubGlobal('scrollY', 220)

    const stop = trackViewport()
    vv.emit('scroll')

    expect(scrollTo).toHaveBeenCalledWith(0, 0)
    stop()
  })

  test('rewrites nothing while the height holds steady', () => {
    const vv = stubVisualViewport(LAYOUT_HEIGHT)
    const stop = trackViewport()

    // visualViewport fires scroll continuously during a drag, and a custom
    // property on <html> invalidates style for the whole tree on every write.
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty')
    for (const _ of [1, 2, 3, 4, 5]) vv.emit('scroll')
    expect(setProperty).not.toHaveBeenCalled()

    vv.height = 508
    vv.emit('resize')
    expect(setProperty).toHaveBeenCalledTimes(1)

    setProperty.mockRestore()
    stop()
  })

  test('detaches every listener it attached', () => {
    const vv = stubVisualViewport(LAYOUT_HEIGHT)
    const stop = trackViewport()

    expect(vv.count('resize')).toBe(1)
    expect(vv.count('scroll')).toBe(1)

    stop()
    expect(vv.count('resize')).toBe(0)
    expect(vv.count('scroll')).toBe(0)
  })

  test('falls back to the layout viewport where visualViewport is missing', () => {
    vi.stubGlobal('visualViewport', undefined)
    const stop = trackViewport()

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')
    expect(document.documentElement.dataset.keyboard).toBeUndefined()
    stop()
  })
})
