import type { ServerChatMessage } from '@shared/types.ts'
import { describe, expect, test } from 'vitest'
import { collectUsage, toChatItem, toChatItems } from './chatMapper'
import { toRenderItems } from './chatRenderItems'
import { formatDollars, formatTokens, renderCost } from './costDisplay'

const base: ServerChatMessage = {
  id: 'r1',
  userId: 'u1',
  timestamp: '2026-09-04T10:00:00.000Z',
  role: 'ai',
  content: 'fallback text',
  kind: 'text',
  meta: null,
  inputTokens: null,
  outputTokens: null,
  cacheCreationTokens: null,
  cacheReadTokens: null,
  costUsd: null,
  createdAt: '2026-09-04T10:00:00.000Z',
}

const row = (over: Partial<ServerChatMessage>): ServerChatMessage => ({ ...base, ...over })

const mealSnapshot = {
  id: 'm1',
  timestamp: '2026-09-04T09:00:00.000Z',
  tzOffsetMin: 180,
  meal: 'Breakfast' as const,
  emoji: '🥣',
  foodName: 'Овсянка',
  calories: 320.4,
  protein: 12.6,
  carbs: 54.2,
  fats: 6.5,
}

describe('toChatItem — text', () => {
  test('an ai text row becomes an ai bubble', () => {
    expect(toChatItem(row({ role: 'ai', content: 'привет' }))).toEqual({
      kind: 'ai',
      id: 'r1',
      text: 'привет',
    })
  })

  test('a user text row becomes a user bubble', () => {
    expect(toChatItem(row({ role: 'user', content: 'съел яблоко' }))).toEqual({
      kind: 'user',
      id: 'r1',
      text: 'съел яблоко',
    })
  })

  test('a user row with a thumbnail carries it through', () => {
    const item = toChatItem(
      row({
        role: 'user',
        content: 'что это?',
        meta: { hadImage: true, mediaType: 'image/png', thumb: 'data:image/webp;base64,AA' },
      }),
    )
    expect(item).toMatchObject({ kind: 'user', thumb: 'data:image/webp;base64,AA' })
  })

  test('a photo row with no thumbnail omits the field entirely', () => {
    const item = toChatItem(
      row({ role: 'user', content: 'x', meta: { hadImage: true, mediaType: 'image/png' } }),
    )
    expect(item).toEqual({ kind: 'user', id: 'r1', text: 'x' })
  })
})

describe('toChatItem — meals', () => {
  test('meal_added rounds every macro', () => {
    const item = toChatItem(row({ kind: 'meal_added', meta: { mealId: 'm1', meal: mealSnapshot } }))
    expect(item).toEqual({
      kind: 'mealAdded',
      id: 'r1',
      item: { emoji: '🥣', name: 'Овсянка', kcal: 320, protein: 13, carbs: 54, fat: 7 },
    })
  })

  test('a missing emoji falls back to the plate glyph', () => {
    const item = toChatItem(
      row({ kind: 'meal_added', meta: { mealId: 'm1', meal: { ...mealSnapshot, emoji: null } } }),
    )
    expect(item).toMatchObject({ item: { emoji: '🍽' } })
  })

  test('meal_updated exposes both halves', () => {
    const item = toChatItem(
      row({
        kind: 'meal_updated',
        meta: {
          mealId: 'm1',
          before: mealSnapshot,
          after: { ...mealSnapshot, calories: 350 },
        },
      }),
    )
    expect(item).toMatchObject({ kind: 'mealUpdated', before: { kcal: 320 }, after: { kcal: 350 } })
  })

  test('meal_removed maps to its own kind', () => {
    expect(
      toChatItem(row({ kind: 'meal_removed', meta: { mealId: 'm1', meal: mealSnapshot } })),
    ).toMatchObject({ kind: 'mealRemoved' })
  })
})

describe('toChatItem — goal', () => {
  test('goal_set rounds the targets', () => {
    const item = toChatItem(
      row({
        kind: 'goal_set',
        meta: {
          goalId: 'g1',
          goal: {
            id: 'g1',
            date: '2026-09-04',
            dayType: 'training' as const,
            calorieGoal: 2650.5,
            proteinGGoal: 170.2,
            carbsGGoal: 330.7,
            fatGGoal: 74.4,
          },
        },
      }),
    )
    expect(item).toEqual({
      kind: 'goalSet',
      id: 'r1',
      item: {
        date: '2026-09-04',
        dayType: 'training',
        kcal: 2651,
        protein: 170,
        carbs: 331,
        fat: 74,
      },
    })
  })
})

// The asymmetry is deliberate and matches Models.swift: most kinds degrade to a
// plain bubble, but the two memory kinds whose text IS the payload still render
// as cards.
describe('toChatItem — fallbacks when meta is unusable', () => {
  test.each([
    'meal_added',
    'meal_removed',
    'meal_updated',
    'goal_set',
    'memory_updated',
    'recommend',
  ] as const)('%s degrades to an ai bubble', (kind) => {
    expect(toChatItem(row({ kind, meta: null }))).toEqual({
      kind: 'ai',
      id: 'r1',
      text: 'fallback text',
    })
  })

  test('memory_added still renders a card, using content', () => {
    expect(toChatItem(row({ kind: 'memory_added', meta: null, content: 'Аллергия' }))).toEqual({
      kind: 'memoryAdded',
      id: 'r1',
      content: 'Аллергия',
    })
  })

  test('memory_removed still renders a card, using content', () => {
    expect(toChatItem(row({ kind: 'memory_removed', meta: null, content: 'Аллергия' }))).toEqual({
      kind: 'memoryRemoved',
      id: 'r1',
      content: 'Аллергия',
    })
  })

  test('a meta of the wrong shape is treated as absent', () => {
    expect(toChatItem(row({ kind: 'meal_added', meta: { unrelated: 1 } }))).toMatchObject({
      kind: 'ai',
    })
    expect(toChatItem(row({ kind: 'meal_added', meta: 'a string' }))).toMatchObject({ kind: 'ai' })
  })

  test('an unknown kind degrades to an ai bubble', () => {
    expect(toChatItem(row({ kind: 'something_new' as never }))).toMatchObject({ kind: 'ai' })
  })
})

describe('toChatItems', () => {
  // GET /chat returns newest-first; the chat displays chronologically.
  test('reverses the server order', () => {
    const items = toChatItems([
      row({ id: 'newest', content: 'третье' }),
      row({ id: 'middle', content: 'второе' }),
      row({ id: 'oldest', content: 'первое' }),
    ])
    expect(items.map((i) => i.id)).toEqual(['oldest', 'middle', 'newest'])
  })

  test('does not mutate the input array', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })]
    toChatItems(rows)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

const recMeta = (color: 'green' | 'yellow') => ({
  currentColor: 'yellow' as const,
  color,
  foods: [],
  addedMacros: { calories: 0, protein: 0, fat: 0, carbs: 0 },
  finalMacros: { calories: 2000, protein: 150, fat: 60, carbs: 200 },
})

describe('toRenderItems', () => {
  const ai = (id: string): ChatItemLike => ({ kind: 'ai', id, text: id })
  type ChatItemLike = Parameters<typeof toRenderItems>[0][number]
  const rec = (id: string, color: 'green' | 'yellow' = 'green'): ChatItemLike => ({
    kind: 'recommendation',
    id,
    payload: recMeta(color),
  })

  test('leaves non-recommendation items alone', () => {
    expect(toRenderItems([ai('a'), ai('b')])).toEqual([
      { kind: 'single', id: 'a', item: ai('a') },
      { kind: 'single', id: 'b', item: ai('b') },
    ])
  })

  test('collapses a consecutive run into one deck', () => {
    const out = toRenderItems([rec('r1'), rec('r2', 'yellow'), rec('r3')])
    expect(out).toHaveLength(1)
    const deck = out[0]
    expect(deck).toMatchObject({ kind: 'deck', id: 'deck-r1' })
    expect(deck?.kind === 'deck' ? deck.variants : []).toHaveLength(3)
  })

  test('the deck id comes from the first row so it is stable across reloads', () => {
    expect(toRenderItems([rec('first'), rec('second')])[0]!.id).toBe('deck-first')
  })

  test('a non-recommendation item between runs starts a new deck', () => {
    const out = toRenderItems([rec('a1'), rec('a2'), ai('text'), rec('b1')])
    expect(out.map((i) => i.kind)).toEqual(['deck', 'single', 'deck'])
    expect(out[0]!.id).toBe('deck-a1')
    expect(out[2]!.id).toBe('deck-b1')
  })

  test('a lone recommendation still becomes a one-variant deck', () => {
    const out = toRenderItems([rec('solo')])
    const deck = out[0]
    expect(deck).toMatchObject({ kind: 'deck' })
    expect(deck?.kind === 'deck' ? deck.variants : []).toHaveLength(1)
  })

  test('an empty list yields an empty list', () => {
    expect(toRenderItems([])).toEqual([])
  })
})

describe('collectUsage', () => {
  test('picks up only rows carrying usage', () => {
    const usage = collectUsage([
      row({ id: 'plain' }),
      row({ id: 'stamped', inputTokens: 612, outputTokens: 184, costUsd: 0.0042 }),
    ])
    expect(Object.keys(usage)).toEqual(['stamped'])
    expect(usage.stamped).toEqual({
      inputTokens: 612,
      outputTokens: 184,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0.0042,
    })
  })

  test('a row missing any of the three required fields is skipped', () => {
    expect(collectUsage([row({ inputTokens: 1, outputTokens: 2 })])).toEqual({})
    expect(collectUsage([row({ inputTokens: 1, costUsd: 0.1 })])).toEqual({})
  })
})

describe('cost display', () => {
  const usage = {
    inputTokens: 612,
    outputTokens: 184,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.0042,
  }

  test('sub-cent costs get four decimals, larger ones three', () => {
    expect(formatDollars(0.0042)).toBe('$0.0042')
    expect(formatDollars(0.01)).toBe('$0.010')
    expect(formatDollars(1.2345)).toBe('$1.234')
  })

  test('tokens read as in→out', () => {
    expect(formatTokens(usage)).toBe('612→184 tok')
  })

  test('each mode renders its own shape', () => {
    expect(renderCost('none', usage)).toBeNull()
    expect(renderCost('dollars', usage)).toBe('$0.0042')
    expect(renderCost('tokens', usage)).toBe('612→184 tok')
    expect(renderCost('both', usage)).toBe('$0.0042 · 612→184 tok')
  })

  test('a row with no usage renders nothing in any mode', () => {
    for (const mode of ['none', 'dollars', 'tokens', 'both'] as const) {
      expect(renderCost(mode, undefined)).toBeNull()
    }
  })
})
