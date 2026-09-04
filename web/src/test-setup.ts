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
