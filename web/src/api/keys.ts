import { QueryClient } from '@tanstack/react-query'

// Query keys, kept in one place so invalidation after a chat write cannot drift
// from the keys the screens subscribe to.

export const qk = {
  goalsAll: ['goals', 'all'] as const,
  goal: (date: string) => ['goals', date] as const,
  meals: (from: string, to: string) => ['meals', from, to] as const,
  daySummaries: (from: string, to: string) => ['day-summary', from, to] as const,
  chat: (limit: number) => ['chat', limit] as const,
  memories: ['memories'] as const,
  weights: ['weights'] as const,
}

/** Every key a chat turn can invalidate once the LLM wrote something. */
export const INVALIDATE_ON_MEAL_WRITE = [['meals'], ['day-summary']]
export const INVALIDATE_ON_GOAL_WRITE = [['goals'], ['day-summary']]

/**
 * Replaces the hand-rolled refresh orchestration in AppState:
 *   * staleTime mirrors `tabRefreshThrottle` (5s) so flicking between tabs does
 *     not hammer the API;
 *   * refetchOnWindowFocus mirrors `handleScenePhase`, which pulled everything
 *     fresh after the app had been away;
 *   * retry is off here because the policy lives in api(), where it can
 *     distinguish a transport failure from a 4xx — matching the Swift client.
 *
 * It also removes the four spinner counters AppState carried. They were
 * counters rather than booleans so overlapping refreshes could not switch the
 * spinner off early; `isFetching` gives that for free.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: false,
      },
      mutations: { retry: false },
    },
  })
}
