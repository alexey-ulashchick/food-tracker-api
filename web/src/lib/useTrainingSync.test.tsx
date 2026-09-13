import { createQueryClient } from '@/api/keys'
import { useTrainingSync } from '@/lib/useTrainingSync'
import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The hook runs on every screen, so the two things worth pinning are that it
// tells the cache when goals changed underneath it, and that it stays quiet
// when they did not — an invalidation storm here would refetch Today, History
// and the day summaries on a loop.

const syncTraining = vi.fn()

vi.mock('@/api/endpoints', () => ({
  syncTraining: (force: boolean) => syncTraining(force),
}))

function setup() {
  const client = createQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = renderHook(() => useTrainingSync(), { wrapper })
  return { ...view, invalidate }
}

const keysOf = (invalidate: { mock: { calls: unknown[][] } }) =>
  invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0])

beforeEach(() => {
  syncTraining.mockReset()
})

describe('useTrainingSync', () => {
  test('asks for a plain sync, letting the server cache decide', async () => {
    // force is the refresh button's job, not the background pass's.
    syncTraining.mockResolvedValue({ configured: true, written: 0, syncedAt: 'a', skipped: 0 })
    const { result } = setup()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(syncTraining).toHaveBeenCalledWith(false)
  })

  test('invalidates everything derived from a goal once rows changed', async () => {
    syncTraining.mockResolvedValue({ configured: true, written: 22, syncedAt: 'a', skipped: 0 })
    const { result, invalidate } = setup()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await waitFor(() => expect(keysOf(invalidate)).toContain('goals'))
    expect(keysOf(invalidate)).toContain('day-summary')
  })

  test('never invalidates its own key, which would loop', async () => {
    syncTraining.mockResolvedValue({ configured: true, written: 22, syncedAt: 'a', skipped: 0 })
    const { result, invalidate } = setup()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(keysOf(invalidate)).not.toContain('training-sync')
  })

  test('stays quiet when the sync wrote nothing', async () => {
    syncTraining.mockResolvedValue({ configured: true, written: 0, syncedAt: 'a', skipped: 3 })
    const { result, invalidate } = setup()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).not.toHaveBeenCalled()
  })

  test('stays quiet when the integration is not set up', async () => {
    syncTraining.mockResolvedValue({ configured: false, missing: ['baseCalories'] })
    const { result, invalidate } = setup()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invalidate).not.toHaveBeenCalled()
  })

  test('a failing sync does not take the screen down with it', async () => {
    // An expired intervals.icu key should leave yesterday's goals showing.
    syncTraining.mockRejectedValue(new Error('502'))
    const { result } = setup()

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(Error)
  })
})
