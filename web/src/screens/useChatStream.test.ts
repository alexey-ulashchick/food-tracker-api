import { ApiError } from '@/api/client'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useChatStream } from './useChatStream'

// Covers what survives the end of a turn.
//
// The screen finishes every turn by refetching the persisted chat rows and then
// calling reset(), which clears the local mirror so committed rows are not shown
// twice. That only holds for items the server actually wrote. /chat/recommend
// answers a missing daily goal and returns before it persists anything, so its
// card has no server twin — clearing it unconditionally made the only feedback
// that path produces vanish a moment after it appeared.

const streamRecommend = vi.fn()
const streamChat = vi.fn()

vi.mock('@/api/endpoints', () => ({
  streamRecommend: (onEvent: (e: { event: string; data: string }) => void) =>
    streamRecommend(onEvent),
  streamChat: (
    content: string,
    attachment: unknown,
    onEvent: (e: { event: string; data: string }) => void,
  ) => streamChat(content, attachment, onEvent),
}))

beforeEach(() => {
  streamRecommend.mockReset()
  streamChat.mockReset()
})

/** The row shape /chat/stream persists for a plain assistant reply. */
function aiRow(id: string, content: string) {
  return {
    id,
    userId: 'u',
    role: 'ai',
    content,
    kind: 'text',
    meta: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    costUsd: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('reset after a turn', () => {
  test('keeps the missing-goal card, which the server never persisted', async () => {
    streamRecommend.mockImplementation((onEvent: (e: { event: string; data: string }) => void) => {
      onEvent({
        event: 'error',
        data: JSON.stringify({ code: 'no_goal', message: 'Сначала выстави цель на день.' }),
      })
      return Promise.resolve()
    })

    const onError = vi.fn()
    const { result } = renderHook(() => useChatStream({ onError }))

    await act(async () => {
      await result.current.recommend()
    })

    // The optimistic "/recommend" bubble is local too, but the server did record
    // nothing for it either way, so reset drops it and keeps only the feedback.
    expect(result.current.live.map((i) => i.kind)).toEqual(['user', 'recommendationError'])
    // A missing goal is actionable, so it is a card rather than the banner.
    expect(onError).not.toHaveBeenCalled()

    act(() => {
      result.current.reset()
    })

    expect(result.current.live).toHaveLength(1)
    expect(result.current.live[0]).toMatchObject({
      kind: 'recommendationError',
      message: 'Сначала выстави цель на день.',
    })
  })

  test('drops committed rows, which the refetched history already carries', async () => {
    streamChat.mockImplementation(
      (
        _content: string,
        _attachment: unknown,
        onEvent: (e: { event: string; data: string }) => void,
      ) => {
        onEvent({
          event: 'message',
          data: JSON.stringify({ blockId: null, row: aiRow('row-1', 'Готово.') }),
        })
        onEvent({ event: 'done', data: JSON.stringify({ count: 1 }) })
        return Promise.resolve()
      },
    )

    const { result } = renderHook(() => useChatStream({ onError: vi.fn() }))

    await act(async () => {
      await result.current.send('привет', null)
    })

    expect(result.current.live.length).toBeGreaterThan(0)

    act(() => {
      result.current.reset()
    })

    expect(result.current.live).toEqual([])
  })

  test('a following turn replaces a retained card instead of stacking one more', async () => {
    streamRecommend.mockImplementation((onEvent: (e: { event: string; data: string }) => void) => {
      onEvent({
        event: 'error',
        data: JSON.stringify({ code: 'no_goal', message: 'Сначала выстави цель на день.' }),
      })
      return Promise.resolve()
    })

    const { result } = renderHook(() => useChatStream({ onError: vi.fn() }))

    for (const _ of [1, 2, 3]) {
      await act(async () => {
        await result.current.recommend()
      })
      act(() => {
        result.current.reset()
      })
    }

    expect(result.current.live).toHaveLength(1)
  })
})

describe('the turn-in-progress indicator', () => {
  // The dots used to be a list entry, and every event began by removing it. The
  // first event of a turn is `user`, emitted as soon as the row is persisted and
  // well before the model has produced anything — so they were erased instantly
  // and never returned while tools ran. They are derived from status now; this
  // pins the two facts a caller needs to render them.
  test('status stays busy from the user event until the stream closes', async () => {
    const seen: string[] = []
    let resolveStream: (() => void) | undefined

    streamChat.mockImplementation(
      (
        _content: string,
        _attachment: unknown,
        onEvent: (e: { event: string; data: string }) => void,
      ) => {
        onEvent({ event: 'user', data: JSON.stringify(aiRow('u-1', 'привет')) })
        return new Promise<void>((resolve) => {
          resolveStream = () => {
            onEvent({
              event: 'message',
              data: JSON.stringify({ blockId: null, row: aiRow('a-1', 'Готово.') }),
            })
            onEvent({ event: 'done', data: JSON.stringify({ count: 1 }) })
            resolve()
          }
        })
      },
    )

    const { result } = renderHook(() => useChatStream({ onError: vi.fn() }))

    let pending: Promise<unknown> | undefined
    await act(async () => {
      pending = result.current.send('привет', null)
      await Promise.resolve()
    })

    // The user row has landed and the model has not answered: this is exactly
    // the window the dots exist for.
    seen.push(result.current.status.kind)
    expect(result.current.live.some((i) => i.kind === 'streaming')).toBe(false)

    await act(async () => {
      resolveStream?.()
      await pending
    })
    seen.push(result.current.status.kind)

    expect(seen).toEqual(['busy', 'idle'])
  })

  test('a streamed delta is what silences them, not the user event', async () => {
    streamChat.mockImplementation(
      (
        _content: string,
        _attachment: unknown,
        onEvent: (e: { event: string; data: string }) => void,
      ) => {
        onEvent({ event: 'user', data: JSON.stringify(aiRow('u-2', 'привет')) })
        onEvent({ event: 'delta', data: JSON.stringify({ blockId: '0-0', text: 'Счи' }) })
        return Promise.resolve()
      },
    )

    const { result } = renderHook(() => useChatStream({ onError: vi.fn() }))
    await act(async () => {
      await result.current.send('привет', null)
    })

    // With text on screen the caller hides the dots; the streaming item is the
    // signal it reads.
    expect(result.current.live.some((i) => i.kind === 'streaming')).toBe(true)
  })
})

describe('a stream that dies mid-turn', () => {
  // The server does not stop when the socket does — rows are persisted as they
  // are produced — so a drop leaves the turn running and the outcome unknown to
  // this client. It reports that, rather than forwarding WebKit's "Load failed".
  test('reports itself interrupted when no done frame arrived', async () => {
    streamChat.mockImplementation(
      (
        _content: string,
        _attachment: unknown,
        onEvent: (e: { event: string; data: string }) => void,
      ) => {
        onEvent({ event: 'user', data: JSON.stringify(aiRow('u-1', 'обед как вчера')) })
        return Promise.reject(new TypeError('Load failed'))
      },
    )

    const onError = vi.fn()
    const { result } = renderHook(() => useChatStream({ onError }))

    let outcome: { interrupted: boolean } | undefined
    await act(async () => {
      outcome = await result.current.send('обед как вчера', null)
    })

    expect(outcome?.interrupted).toBe(true)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain('Соединение прервалось')
    // Not the transport's wording, which says nothing a user can act on.
    expect(String(onError.mock.calls[0]?.[0])).not.toContain('Load failed')
  })

  test('a completed turn is not interrupted and raises nothing', async () => {
    streamChat.mockImplementation(
      (
        _content: string,
        _attachment: unknown,
        onEvent: (e: { event: string; data: string }) => void,
      ) => {
        onEvent({
          event: 'message',
          data: JSON.stringify({ blockId: null, row: aiRow('a-1', 'Записал.') }),
        })
        onEvent({ event: 'done', data: JSON.stringify({ count: 1 }) })
        return Promise.resolve()
      },
    )

    const onError = vi.fn()
    const { result } = renderHook(() => useChatStream({ onError }))

    let outcome: { interrupted: boolean } | undefined
    await act(async () => {
      outcome = await result.current.send('привет', null)
    })

    expect(outcome?.interrupted).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  test('a real HTTP error keeps its own message', async () => {
    streamChat.mockImplementation(() =>
      Promise.reject(new ApiError(400, '{"error":"invalid or oversized thumb"}')),
    )

    const onError = vi.fn()
    const { result } = renderHook(() => useChatStream({ onError }))
    await act(async () => {
      await result.current.send('привет', null)
    })

    // A 400 is the server saying something specific; do not paper over it.
    expect(String(onError.mock.calls[0]?.[0])).toContain('400')
    expect(String(onError.mock.calls[0]?.[0])).not.toContain('Соединение прервалось')
  })
})
