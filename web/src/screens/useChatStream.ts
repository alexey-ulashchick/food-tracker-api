import { type ChatAttachment, streamChat, streamRecommend } from '@/api/endpoints'
import type { SseEvent } from '@/api/sse'
import { type ChatItem, type TurnUsage, toChatItem } from '@/lib/chatMapper'
import type { ServerChatMessage } from '@shared/types.ts'
import { useCallback, useState } from 'react'

// Owns everything a chat turn does to the on-screen list.
//
// The subtle part is `retract`. The server's write-claim guard decides only
// after every tool in a turn has run, so a false "записал" has already been
// streamed by the time it is rejected. Streamed text therefore lives in a
// provisional bubble keyed by blockId, and is either committed by a `message`
// frame or dropped by a `retract` one.

/** Local ids are prefixed so they can never collide with a database uuid. */
const LOCAL = 'local-'

export type ChatStatus = { kind: 'idle' } | { kind: 'busy' }

export type SendResult = {
  /** Kinds the turn persisted, so the caller knows which queries to refresh. */
  touched: Set<string>
}

type Options = {
  onError: (message: string) => void
}

export function useChatStream({ onError }: Options) {
  // Items produced by the turn in flight. Committed rows are merged into the
  // server history by the screen once the turn ends.
  const [live, setLive] = useState<ChatItem[]>([])
  const [usage, setUsage] = useState<Record<string, TurnUsage>>({})
  const [status, setStatus] = useState<ChatStatus>({ kind: 'idle' })

  // Drops the turn's local mirror once the screen has refetched the persisted
  // rows. Items the server never wrote have no such replacement and would
  // simply blink out, so they are kept: /chat/recommend answers a missing daily
  // goal before it persists anything at all, and that card is the only feedback
  // the click produces. A retained card cannot pile up — the next turn's
  // setLive replaces the whole list.
  const reset = useCallback(() => {
    setLive((items) => items.filter((i) => i.kind === 'recommendationError'))
    setUsage({})
  }, [])

  const run = useCallback(
    async (
      open: (onEvent: (e: SseEvent) => void) => Promise<void>,
      optimistic: ChatItem[],
    ): Promise<SendResult> => {
      const touched = new Set<string>()
      // Text accumulating per streamed block, so a delta can append.
      const blocks = new Map<string, string>()

      setStatus({ kind: 'busy' })
      setLive(optimistic)

      const handle = (event: SseEvent) => {
        const data = safeParse(event.data)

        switch (event.event) {
          case 'user': {
            // The persisted row replaces the optimistic bubble, so a reload
            // shows the same id the server assigned.
            const row = data as ServerChatMessage
            setLive((items) => [toChatItem(row), ...dropOptimisticUser(items)])
            break
          }

          case 'delta': {
            const { blockId, text } = data as { blockId: string; text: string }
            blocks.set(blockId, (blocks.get(blockId) ?? '') + text)
            const id = streamingId(blockId)
            const accumulated = blocks.get(blockId) ?? ''
            setLive((items) => {
              const without = items
              const existing = without.findIndex((i) => i.id === id)
              const next: ChatItem = { kind: 'streaming', id, text: accumulated }
              if (existing === -1) return [...without, next]
              const copy = [...without]
              copy[existing] = next
              return copy
            })
            break
          }

          case 'tool': {
            const { name, status: toolStatus } = data as {
              name: string
              status: 'start' | 'ok' | 'error'
            }
            const id = `${LOCAL}tool-${name}`
            setLive((items) => {
              const without = items
              const existing = without.findIndex((i) => i.id === id)
              const next: ChatItem = { kind: 'toolStatus', id, name, status: toolStatus }
              if (existing === -1) return [...without, next]
              const copy = [...without]
              copy[existing] = next
              return copy
            })
            break
          }

          // The guard rejected those blocks: they were never persisted, so the
          // provisional bubbles have to go.
          case 'retract': {
            const { blockIds } = data as { blockIds: string[] }
            const ids = new Set(blockIds.map(streamingId))
            for (const b of blockIds) blocks.delete(b)
            setLive((items) => items.filter((i) => !ids.has(i.id)))
            break
          }

          case 'message': {
            const { blockId, row } = data as { blockId: string | null; row: ServerChatMessage }
            const provisional = blockId ? streamingId(blockId) : null
            setLive((items) => {
              const without = items.filter((i) => i.id !== provisional)
              return [...without, toChatItem(row)]
            })
            break
          }

          case 'card': {
            const row = data as ServerChatMessage
            touched.add(row.kind)
            setLive((items) => [...items, toChatItem(row)])
            break
          }

          case 'usage': {
            const u = data as { messageId: string } & TurnUsage
            setUsage((prev) => ({ ...prev, [u.messageId]: u }))
            break
          }

          // /chat/recommend uses its own names: one row per achievable colour,
          // plus a text row when nothing is reachable.
          case 'recommend':
          case 'text': {
            const row = data as ServerChatMessage
            setLive((items) => [...items, toChatItem(row)])
            break
          }

          case 'error': {
            const { message, code } = data as { message: string; code?: string }
            setLive((items) => {
              const without = items
              // A missing goal is actionable, so it gets its own card rather
              // than the generic banner.
              if (code === 'no_goal') {
                return [
                  ...without,
                  {
                    kind: 'recommendationError',
                    id: `${LOCAL}rec-err-${crypto.randomUUID()}`,
                    message,
                  },
                ]
              }
              return without
            })
            if (code !== 'no_goal') onError(message)
            break
          }

          case 'done':
            break
        }
      }

      try {
        await open(handle)
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setStatus({ kind: 'idle' })
      }

      return { touched }
    },
    [onError],
  )

  const send = useCallback(
    (content: string, attachment: ChatAttachment | null) => {
      const optimistic: ChatItem[] = [
        {
          kind: 'user',
          id: `${LOCAL}user-${crypto.randomUUID()}`,
          text: content,
          ...(attachment ? { thumb: attachment.thumb } : {}),
        },
      ]
      return run((onEvent) => streamChat(content, attachment, onEvent), optimistic)
    },
    [run],
  )

  const recommend = useCallback(() => {
    const optimistic: ChatItem[] = [
      { kind: 'user', id: `${LOCAL}user-${crypto.randomUUID()}`, text: '/recommend' },
    ]
    return run((onEvent) => streamRecommend(onEvent), optimistic)
  }, [run])

  return { live, usage, status, send, recommend, reset }
}

/** `/recommend`, optionally with trailing words — AppState.isRecommendCommand. */
export function isRecommendCommand(text: string): boolean {
  const lower = text.trim().toLowerCase()
  return lower === '/recommend' || lower.startsWith('/recommend ')
}

function streamingId(blockId: string): string {
  return `${LOCAL}stream-${blockId}`
}

function dropOptimisticUser(items: ChatItem[]): ChatItem[] {
  return items.filter((i) => !i.id.startsWith(`${LOCAL}user-`))
}

function safeParse(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return {}
  }
}
