// Reloads when the deployed bundle differs from the running one.
//
// An installed PWA on iOS keeps its document alive for days: reopening from the
// home screen resumes the same page rather than loading it again, so a deploy
// goes unnoticed until the app is force-quit from the app switcher. index.html is
// served no-cache and Vite content-hashes every asset, so the deployed filename
// is already an exact version marker — all that was missing is comparing it.
//
// This is unrelated to re-adding the app to the home screen. That is only ever
// needed for the legacy apple-mobile-web-app-* meta tags, which iOS reads once at
// install time and then caches.

/** Don't re-check on every tab flick. */
const CHECK_MIN_INTERVAL_MS = 30_000
const RELOAD_GUARD_KEY = 'caltracker.lastReload'
/** Never reload twice inside this window: a stale intermediary would otherwise
 *  keep serving the old asset name and the app would loop. */
const RELOAD_GUARD_MS = 60_000

const MODULE_SCRIPT = /<script[^>]+type="module"[^>]+src="([^"]+)"/

/** Path of the module script this document actually booted from. */
function runningBundle(): string | null {
  const tag = document.querySelector<HTMLScriptElement>('script[type="module"][src]')
  if (!tag) return null
  return new URL(tag.src, location.href).pathname
}

/** Path of the module script the server is handing out right now. */
async function deployedBundle(): Promise<string | null> {
  const res = await fetch('/index.html', { cache: 'no-store' })
  if (!res.ok) return null
  return MODULE_SCRIPT.exec(await res.text())?.[1] ?? null
}

type Options = {
  /** Injected so tests can observe the decision instead of navigating. */
  reload?: () => void
}

export function reloadOnNewBundle({ reload = () => location.reload() }: Options = {}): () => void {
  const running = runningBundle()
  let lastCheckAt = 0

  const check = async () => {
    if (running === null) return
    if (document.visibilityState !== 'visible') return

    const now = Date.now()
    if (now - lastCheckAt < CHECK_MIN_INTERVAL_MS) return
    lastCheckAt = now

    const deployed = await deployedBundle().catch(() => null)
    // A failed check is not news: offline, or the machine is cold-starting.
    if (deployed === null || deployed === running) return

    const lastReloadAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0)
    if (now - lastReloadAt < RELOAD_GUARD_MS) return
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now))

    // Losing an in-flight chat turn here would be harmless — every row is
    // persisted server-side before it is streamed — and the check only runs on
    // returning to the app, where a turn is unlikely to be mid-flight anyway.
    reload()
  }

  // Named, so the same reference reaches removeEventListener.
  const onVisibility = () => void check()
  document.addEventListener('visibilitychange', onVisibility)
  return () => document.removeEventListener('visibilitychange', onVisibility)
}
