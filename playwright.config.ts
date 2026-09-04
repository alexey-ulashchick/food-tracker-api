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

  // One project: the app is phone-first and the tab shell only exists there.
  projects: [{ name: 'mobile-safari', use: { ...devices['iPhone 14'] } }],

  webServer: {
    // The SPA has to be built first — src/static.ts serves web/dist, not Vite.
    command: `bun run web:build && PORT=${PORT} E2E_FAKE_LLM=1 bun src/index.ts`,
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
