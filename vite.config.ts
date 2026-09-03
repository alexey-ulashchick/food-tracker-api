/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Every API path the backend mounts in src/index.ts. In dev the SPA runs on
// :5173 and proxies these to the Bun server on :3000, so the browser only ever
// talks to one origin — same as production, where Hono serves the built bundle
// itself (src/static.ts). That is why the app needs no CORS middleware anywhere.
const API_PATHS = [
  '/health',
  '/meals',
  '/goals',
  '/memories',
  '/chat',
  '/day-summary',
  '/weights',
  '/mcp',
]

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolvePath('./web/src'),
      '@shared': resolvePath('./shared'),
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [p, { target: 'http://localhost:3000', changeOrigin: false }]),
    ),
  },
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
