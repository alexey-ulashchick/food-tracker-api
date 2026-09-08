import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'
import { trackViewport } from './lib/viewport.ts'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// Sizes the shell to the visual viewport. Deliberately outside React: it owns a
// CSS variable on <html>, and nothing in the tree reads it.
trackViewport()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
