import { defineConfig, devices } from '@playwright/test'

// End-to-end runs against the real stack: the Bun server serving the built SPA
// from the same origin, exactly as production does. The LLM is stubbed via
// E2E_FAKE_LLM so no Anthropic key or spend is involved.

const PORT = 3100

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },

  // Two shells, two projects. Both are WebKit — devices['Desktop Safari'] sets
  // defaultBrowserType: 'webkit' — so CI's `playwright install webkit` already
  // covers the new one and the workflow needs no change.
  //
  // Split by file rather than by running every spec twice: workers is 1, so the
  // suite's wall clock is the sum of everything in it.
  projects: [
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
      testIgnore: /desktop\.spec\.ts/,
    },
    {
      name: 'desktop-safari',
      // hasTouch is false here, which is what makes (hover: hover) and
      // (pointer: fine) match — the desktop hover rules are only reachable in
      // this project.
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } },
      testMatch: /desktop\.spec\.ts/,
    },
  ],

  webServer: {
    // The SPA has to be built first — src/static.ts serves web/dist, not Vite.
    command: `bun run web:build && PORT=${PORT} E2E_FAKE_LLM=1 bun src/index.ts`,
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
