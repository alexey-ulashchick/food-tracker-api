import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reloadOnNewBundle } from './reloadOnNewBundle'

// Vite content-hashes the module script, so its filename is an exact version
// marker. Comparing the running one against the one the server is handing out is
// what lets an installed PWA — which resumes its old document indefinitely —
// notice a deploy on returning to the foreground.

const RUNNING = '/assets/index-aaaa1111.js'
const DEPLOYED = '/assets/index-bbbb2222.js'

function html(src: string) {
  return `<!doctype html><html><head></head><body><div id="root"></div><script type="module" crossorigin src="${src}"></script></body></html>`
}

function serve(src: string | null, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      text: async () => (src === null ? '<html></html>' : html(src)),
    })),
  )
}

/** The document's own module script, which runningBundle() reads. */
function bootFrom(src: string) {
  const tag = document.createElement('script')
  tag.type = 'module'
  tag.src = src
  document.body.appendChild(tag)
}

function foreground() {
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reloadOnNewBundle', () => {
  test('reloads when the deployed script differs from the running one', async () => {
    bootFrom(RUNNING)
    serve(DEPLOYED)
    const reload = vi.fn()

    const stop = reloadOnNewBundle({ reload })
    foreground()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    stop()
  })

  test('stays put when the deployed script is the running one', async () => {
    bootFrom(RUNNING)
    serve(RUNNING)
    const reload = vi.fn()

    const stop = reloadOnNewBundle({ reload })
    foreground()
    await Promise.resolve()
    await Promise.resolve()

    expect(reload).not.toHaveBeenCalled()
    stop()
  })

  test('reloads at most once per minute, so a stale cache cannot loop', async () => {
    bootFrom(RUNNING)
    serve(DEPLOYED)
    const reload = vi.fn()

    // A reload just happened and the server is still handing out the old name.
    sessionStorage.setItem('caltracker.lastReload', String(Date.now()))

    const stop = reloadOnNewBundle({ reload })
    foreground()
    await Promise.resolve()
    await Promise.resolve()

    expect(reload).not.toHaveBeenCalled()
    stop()
  })

  test('treats a failed check as no news', async () => {
    bootFrom(RUNNING)
    serve(DEPLOYED, false)
    const reload = vi.fn()

    const stop = reloadOnNewBundle({ reload })
    foreground()
    await Promise.resolve()
    await Promise.resolve()

    // Offline, or the machine is cold-starting: not a reason to reload.
    expect(reload).not.toHaveBeenCalled()
    stop()
  })

  test('detaches its listener', async () => {
    bootFrom(RUNNING)
    serve(DEPLOYED)
    const reload = vi.fn()

    const stop = reloadOnNewBundle({ reload })
    stop()
    foreground()
    await Promise.resolve()
    await Promise.resolve()

    expect(reload).not.toHaveBeenCalled()
  })
})
