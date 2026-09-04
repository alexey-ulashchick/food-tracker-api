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

// jsdom implements neither of these, and both are used by real screens: the
// chat list anchors to its newest row, and IntersectionObserver drives the
// History list's infinite scroll.
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
