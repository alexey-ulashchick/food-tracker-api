import type { Food, Goal } from '@/components/cards/FoodCard'
import type {
  GoalSetMeta,
  MealAddedMeta,
  MealRemovedMeta,
  MealSnapshot,
  MealUpdatedMeta,
  MemoryAddedMeta,
  MemoryRemovedMeta,
  MemoryUpdatedMeta,
  RecommendationMeta,
  ServerChatMessage,
  UserImageMeta,
} from '@shared/types.ts'

// Port of AppState.toLocal (Models.swift:909): turns a chat_messages row into
// the item the chat surface renders.
//
// The fallbacks are not uniform, and that asymmetry is deliberate in the
// original: when `meta` fails to decode, most kinds degrade to a plain ai
// bubble, but memory_added and memory_removed still render as memory cards
// using `content`, because the row's text IS the memory.

export type ChatItem =
  | { kind: 'user'; id: string; text: string; thumb?: string }
  | { kind: 'ai'; id: string; text: string }
  | { kind: 'mealAdded'; id: string; item: Food }
  | { kind: 'mealRemoved'; id: string; item: Food }
  | { kind: 'mealUpdated'; id: string; before: Food; after: Food }
  | { kind: 'goalSet'; id: string; item: Goal }
  | { kind: 'memoryAdded'; id: string; content: string }
  | { kind: 'memoryUpdated'; id: string; before: string; after: string }
  | { kind: 'memoryRemoved'; id: string; content: string }
  | { kind: 'recommendation'; id: string; payload: RecommendationMeta }
  // Local-only, never persisted.
  | { kind: 'recommendationError'; id: string; message: string }
  | { kind: 'typing'; id: string }
  | { kind: 'streaming'; id: string; text: string }
  | { kind: 'toolStatus'; id: string; name: string; status: 'start' | 'ok' | 'error' }

/** Macros are rounded on the way in — the UI never shows fractional grams. */
export function foodFromSnapshot(m: MealSnapshot): Food {
  return {
    emoji: m.emoji ?? '🍽',
    name: m.foodName,
    kcal: Math.round(m.calories),
    protein: Math.round(m.protein),
    carbs: Math.round(m.carbs),
    fat: Math.round(m.fats),
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Narrow `meta` only when it carries the field the caller needs. */
function metaWith<T>(meta: unknown, key: string): T | null {
  if (!isObject(meta)) return null
  return key in meta ? (meta as T) : null
}

export function toChatItem(row: ServerChatMessage): ChatItem {
  const id = row.id
  const asAi: ChatItem = { kind: 'ai', id, text: row.content }

  switch (row.kind) {
    case 'text': {
      if (row.role === 'ai') return asAi
      const image = metaWith<UserImageMeta>(row.meta, 'hadImage')
      return {
        kind: 'user',
        id,
        text: row.content,
        ...(image?.thumb ? { thumb: image.thumb } : {}),
      }
    }

    case 'meal_added': {
      const meta = metaWith<MealAddedMeta>(row.meta, 'meal')
      return meta ? { kind: 'mealAdded', id, item: foodFromSnapshot(meta.meal) } : asAi
    }

    case 'meal_removed': {
      const meta = metaWith<MealRemovedMeta>(row.meta, 'meal')
      return meta ? { kind: 'mealRemoved', id, item: foodFromSnapshot(meta.meal) } : asAi
    }

    case 'meal_updated': {
      const meta = metaWith<MealUpdatedMeta>(row.meta, 'after')
      return meta
        ? {
            kind: 'mealUpdated',
            id,
            before: foodFromSnapshot(meta.before),
            after: foodFromSnapshot(meta.after),
          }
        : asAi
    }

    case 'goal_set': {
      const meta = metaWith<GoalSetMeta>(row.meta, 'goal')
      if (!meta) return asAi
      const g = meta.goal
      return {
        kind: 'goalSet',
        id,
        item: {
          date: g.date,
          dayType: g.dayType,
          kcal: Math.round(g.calorieGoal),
          protein: Math.round(g.proteinGGoal),
          carbs: Math.round(g.carbsGGoal),
          fat: Math.round(g.fatGGoal),
        },
      }
    }

    // The row's content is the memory text, so a card is still the right
    // rendering even without meta.
    case 'memory_added': {
      const meta = metaWith<MemoryAddedMeta>(row.meta, 'memory')
      return { kind: 'memoryAdded', id, content: meta?.memory.content ?? row.content }
    }

    case 'memory_removed': {
      const meta = metaWith<MemoryRemovedMeta>(row.meta, 'memory')
      return { kind: 'memoryRemoved', id, content: meta?.memory.content ?? row.content }
    }

    // An update needs both halves to be worth showing as a diff.
    case 'memory_updated': {
      const meta = metaWith<MemoryUpdatedMeta>(row.meta, 'after')
      return meta
        ? { kind: 'memoryUpdated', id, before: meta.before.content, after: meta.after.content }
        : asAi
    }

    case 'recommend': {
      const meta = metaWith<RecommendationMeta>(row.meta, 'finalMacros')
      return meta ? { kind: 'recommendation', id, payload: meta } : asAi
    }

    default:
      return asAi
  }
}

/** Server history arrives newest-first; the chat reads chronologically. */
export function toChatItems(rows: ServerChatMessage[]): ChatItem[] {
  return [...rows].reverse().map(toChatItem)
}

export type TurnUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
}

/**
 * Usage is stamped on the LAST ai row of each turn and null everywhere else, so
 * most rows skip the map entirely.
 */
export function collectUsage(rows: ServerChatMessage[]): Record<string, TurnUsage> {
  const out: Record<string, TurnUsage> = {}
  for (const row of rows) {
    if (row.inputTokens == null || row.outputTokens == null || row.costUsd == null) continue
    out[row.id] = {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheCreationTokens: row.cacheCreationTokens ?? 0,
      cacheReadTokens: row.cacheReadTokens ?? 0,
      costUsd: row.costUsd,
    }
  }
  return out
}
