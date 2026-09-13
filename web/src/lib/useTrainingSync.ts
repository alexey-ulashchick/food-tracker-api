import { syncTraining } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

/**
 * Keeps the automatic goals current, wherever you are in the app.
 *
 * Driven by useQuery rather than an effect because the requirement is a cache
 * policy — "at most once every few minutes, and again when the tab comes back"
 * — and that is exactly what staleTime plus refetchOnWindowFocus is. The POST
 * is idempotent (a deterministic computation followed by an upsert), so
 * running it on a schedule the user cannot see is safe.
 */
const STALE_MS = 5 * 60 * 1000

export function useTrainingSync() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: qk.trainingSync,
    queryFn: () => syncTraining(false),
    staleTime: STALE_MS,
    // A failing sync must not take the screen down with it: an expired
    // intervals.icu key should leave yesterday's goals showing, not a blank
    // Today. It is also deliberately NOT pushed to the global error banner —
    // this runs on every screen, and a banner on all of them for a settings
    // problem would be noise. The profile card is where the failure shows,
    // because that is where the last-sync time stops advancing.
    retry: false,
    throwOnError: false,
  })

  const written = query.data?.configured ? query.data.written : 0
  const syncedAt = query.data?.configured ? query.data.syncedAt : null

  // biome-ignore lint/correctness/useExhaustiveDependencies: syncedAt is an invalidation key, not a value the body reads. Without it the effect is keyed on `written` alone, and two consecutive syncs that happen to write the same number of rows — the normal case, since the window is a fixed length — would look identical and the second one would not invalidate anything.
  useEffect(() => {
    if (written === 0) return
    // Rows changed underneath the cache, so anything derived from a goal is
    // now stale. Not the sync's own key — that would loop.
    void queryClient.invalidateQueries({ queryKey: ['goals'] })
    void queryClient.invalidateQueries({ queryKey: ['day-summary'] })
  }, [written, syncedAt, queryClient])

  return query
}
