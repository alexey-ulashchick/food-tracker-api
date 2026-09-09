import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useElementWidth } from './useElementWidth'

// The charts take their width as a number — it drives the viewBox and the band
// scale — so it has to track the element, not the window. What is pinned here:
// nothing is drawn before the first measurement, later measurements land, and
// the observer is released on unmount.

type Cb = (entries: ResizeObserverEntry[]) => void

/** The live observers a render created, newest last. */
let created: FakeObserver[] = []

class FakeObserver implements ResizeObserver {
  observed: Element[] = []
  disconnected = false
  constructor(readonly cb: Cb) {
    created.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
  /** Plays a resize the way the browser would. */
  emit(width: number) {
    this.cb([{ contentRect: { width } } as ResizeObserverEntry])
  }
}

function Probe({ onWidth }: { onWidth: (w: number) => void }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  onWidth(width)
  return <div ref={ref} />
}

beforeEach(() => {
  created = []
  vi.stubGlobal('ResizeObserver', FakeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useElementWidth', () => {
  test('reports 0 until something measures the element', () => {
    const widths: number[] = []
    render(<Probe onWidth={(w) => widths.push(w)} />)

    // jsdom lays nothing out, so getBoundingClientRect is 0 and the observer
    // has not fired: exactly the state a chart must not draw in.
    expect(widths.at(-1)).toBe(0)
  })

  test('picks up the width the observer reports', () => {
    const widths: number[] = []
    render(<Probe onWidth={(w) => widths.push(w)} />)

    act(() => created[0]?.emit(742))
    expect(widths.at(-1)).toBe(742)

    act(() => created[0]?.emit(391))
    expect(widths.at(-1)).toBe(391)
  })

  test('observes the node it was handed', () => {
    const { container } = render(<Probe onWidth={() => {}} />)
    expect(created[0]?.observed).toEqual([container.querySelector('div')])
  })

  test('a repeated identical measurement leaves the width alone', () => {
    const widths: number[] = []
    render(<Probe onWidth={(w) => widths.push(w)} />)

    act(() => created[0]?.emit(500))
    act(() => created[0]?.emit(500))
    act(() => created[0]?.emit(500))

    // React bails out of a setState that is Object.is-equal, so the value
    // settles instead of feeding a chart that re-measures on every commit.
    expect(widths.at(-1)).toBe(500)
    expect(new Set(widths.slice(1))).toEqual(new Set([500]))
  })

  test('releases the observer on unmount', () => {
    const { unmount } = render(<Probe onWidth={() => {}} />)
    expect(created[0]?.disconnected).toBe(false)

    unmount()
    expect(created[0]?.disconnected).toBe(true)
  })
})
