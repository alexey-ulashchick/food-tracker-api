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
