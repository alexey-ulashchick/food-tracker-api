import type { RecommendationMeta } from '@shared/types.ts'
import type { ChatItem } from './chatMapper'

/**
 * Collapses a run of consecutive `recommendation` items into one deck.
 *
 * Port of ChatRenderItem in ChatView.swift. /chat/recommend emits one row per
 * achievable colour, so a single command leaves four or five rows in the
 * history; rendering them as separate cards would flood the chat.
 *
 * The deck id is derived from the first row so it stays stable across reloads —
 * the Swift version had the same requirement, since an unstable id made the
 * chat scroll jump when the deck re-mounted.
 */

export type RenderItem =
  | { kind: 'single'; id: string; item: ChatItem }
  | { kind: 'deck'; id: string; variants: RecommendationMeta[] }

export function toRenderItems(items: ChatItem[]): RenderItem[] {
  const out: RenderItem[] = []

  for (const item of items) {
    if (item.kind !== 'recommendation') {
      out.push({ kind: 'single', id: item.id, item })
      continue
    }

    const last = out[out.length - 1]
    if (last?.kind === 'deck') {
      last.variants.push(item.payload)
    } else {
      out.push({ kind: 'deck', id: `deck-${item.id}`, variants: [item.payload] })
    }
  }

  return out
}
