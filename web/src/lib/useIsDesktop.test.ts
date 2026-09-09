import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useIsDesktop } from './useIsDesktop'

// The hook reads a CSS custom property rather than repeating the breakpoint in
// JS. What that buys — and what these pin — is that the number lives in exactly
// one place, and that an environment with no stylesheets (jsdom, and every unit
// test in this project) gets the phone shell without stubbing anything.

/** Stands in for the `--desktop` declaration a media query would flip. */
function probeReads(value: string) {
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => value }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useIsDesktop', () => {
  test('is false when no stylesheet declares the probe', () => {
    // The real jsdom case: vitest blanks CSS imports, so nothing sets --desktop.
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)
  })

  test('is false below the breakpoint', () => {
    probeReads('0')
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)
  })

  test('is true above it', () => {
    probeReads('1')
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(true)
  })

  test('tolerates the whitespace getPropertyValue keeps', () => {
    probeReads(' 1 ')
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(true)
  })

  test('follows the probe across a resize', async () => {
    probeReads('0')
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)

    probeReads('1')
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      // The listener coalesces to one read per frame.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    expect(result.current).toBe(true)
  })

  test('stops listening when the last consumer unmounts', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useIsDesktop())
    unmount()

    const events = remove.mock.calls.map((c) => c[0])
    expect(events).toContain('resize')
    expect(events).toContain('orientationchange')
    remove.mockRestore()
  })
})
