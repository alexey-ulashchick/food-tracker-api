import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useColorScheme } from './useColorScheme'

// The hook exists for canvas: everything drawn in CSS follows the theme on its
// own, because the tokens are custom properties. Canvas keeps its pixels, so it
// needs telling. These pin the two things a redraw depends on — the right answer
// on first read, and a subscription that actually fires.

type Listener = () => void

/** A controllable prefers-color-scheme query. */
function stubScheme(light: boolean) {
  const listeners = new Set<Listener>()
  const mq = {
    matches: light,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  }
  vi.stubGlobal('matchMedia', (query: string) => {
    // Only the colour query is answered here; anything else must not be caught
    // by accident — prefers-reduced-motion is asked for by the ring.
    expect(query).toContain('prefers-color-scheme')
    return mq
  })
  return {
    set(next: boolean) {
      mq.matches = next
      for (const fn of [...listeners]) fn()
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useColorScheme', () => {
  test('reads the OS preference on first render', () => {
    stubScheme(true)
    expect(renderHook(() => useColorScheme()).result.current).toBe('light')
  })

  test('reports dark when the query does not match', () => {
    stubScheme(false)
    expect(renderHook(() => useColorScheme()).result.current).toBe('dark')
  })

  test('follows the OS switching mid-session', () => {
    const scheme = stubScheme(false)
    const { result } = renderHook(() => useColorScheme())
    expect(result.current).toBe('dark')

    act(() => scheme.set(true))
    expect(result.current).toBe('light')

    act(() => scheme.set(false))
    expect(result.current).toBe('dark')
  })

  test('releases its listener on unmount', () => {
    const scheme = stubScheme(false)
    const { unmount } = renderHook(() => useColorScheme())
    expect(scheme.listenerCount).toBe(1)

    unmount()
    expect(scheme.listenerCount).toBe(0)
  })

  test('falls back to dark where matchMedia does not exist', () => {
    // jsdom omits it, and so does any non-browser environment. The dark theme is
    // the base, so that is the safe answer.
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => useColorScheme()).result.current).toBe('dark')
  })
})
