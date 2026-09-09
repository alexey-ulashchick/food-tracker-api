import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library only auto-registers its cleanup when the test framework
// exposes globals, and this project runs vitest without `globals: true`. Without
// this, every render stacks up in the same document and `getByRole` starts
// finding several matches across unrelated tests.
afterEach(() => {
  cleanup()
})

// jsdom implements none of these, and all three are used by real screens: the
// chat list anchors to its newest row, IntersectionObserver drives the History
// list's infinite scroll, and ResizeObserver sizes the two SVG charts.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
if (!('IntersectionObserver' in globalThis)) {
  class NoopIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: readonly number[] = []
    disconnect() {}
    observe() {}
    unobserve() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  globalThis.IntersectionObserver =
    NoopIntersectionObserver as unknown as typeof IntersectionObserver
}
// A hook cannot be conditional, so useElementWidth constructs one of these on
// every render of Weight and History. Without the stub those screens throw on
// mount and take the router tests with them.
if (!('ResizeObserver' in globalThis)) {
  class NoopResizeObserver implements ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
}
