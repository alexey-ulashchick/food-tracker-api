import type { CostDisplayMode } from '@/lib/costDisplay'
import { todayIso } from '@/lib/dates'
import { create } from 'zustand'

// UI-only state. Everything that comes from the server lives in TanStack Query;
// this store holds just the three things AppState owned that are not server
// data — which day Today is showing, the cost-display preference, and the error
// banner.

const COST_KEY = 'caltracker.costDisplay'

function readCostDisplay(): CostDisplayMode {
  try {
    const raw = localStorage.getItem(COST_KEY)
    if (raw === 'dollars' || raw === 'tokens' || raw === 'both' || raw === 'none') return raw
  } catch {
    // Private-mode Safari; fall through to the default.
  }
  return 'none'
}

type UiState = {
  /** The calendar day the Today screen is showing, as YYYY-MM-DD. */
  viewingDate: string
  setViewingDate: (iso: string) => void
  resetToToday: () => void

  costDisplay: CostDisplayMode
  setCostDisplay: (mode: CostDisplayMode) => void

  /**
   * Last error worth showing. Lifted to the app shell on purpose: in the Swift
   * app `lastError` was only rendered by ChatView, so a failure on Today or You
   * set the flag invisibly and then surfaced the next time the user opened Chat.
   */
  lastError: string | null
  setError: (message: string | null) => void
}

export const useUi = create<UiState>((set) => ({
  viewingDate: todayIso(),
  setViewingDate: (iso) => set({ viewingDate: iso }),
  resetToToday: () => set({ viewingDate: todayIso() }),

  costDisplay: readCostDisplay(),
  setCostDisplay: (mode) => {
    try {
      localStorage.setItem(COST_KEY, mode)
    } catch {
      // Preference simply will not persist.
    }
    set({ costDisplay: mode })
  },

  lastError: null,
  setError: (message) => set({ lastError: message }),
}))

/** Cancellations are routine (navigating away mid-fetch) and never worth a banner. */
export function surfaceError(err: unknown): void {
  if (err instanceof DOMException && err.name === 'AbortError') return
  const message = err instanceof Error ? err.message : String(err)
  useUi.getState().setError(message)
}
