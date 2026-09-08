import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'
import { reloadOnNewBundle } from './lib/reloadOnNewBundle.ts'
import { trackViewport } from './lib/viewport.ts'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// Sizes the shell to the visual viewport. Deliberately outside React: it owns a
// CSS variable on <html>, and nothing in the tree reads it.
trackViewport()

// Picks up a deploy when the app comes back to the foreground. An installed PWA
// resumes its old document indefinitely otherwise.
reloadOnNewBundle()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
