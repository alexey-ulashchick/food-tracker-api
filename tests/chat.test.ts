import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import { chatMessages, meals } from '../src/db/schema.ts'
import {
  authHeaders,
  llmResponse,
  makeApp,
  seedFoodCard,
  seedUser,
  truncateAll,
} from './helpers.ts'
import { messagesCreate } from './setup.ts'

beforeEach(async () => {
  await truncateAll()
  messagesCreate.mockReset()
})

describe('POST /chat', () => {
  test('text-only: 1 LLM call, 1 ai text row', async () => {
    const userId = crypto.randomUUID()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Привет! Чем могу помочь?' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(userId), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'привет' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      user: { content: string; kind: string }
      ai: Array<{ kind: string; content: string }>
    }
    expect(body.user.content).toBe('привет')
    expect(body.user.kind).toBe('text')
    expect(body.ai).toHaveLength(1)
    expect(body.ai[0]).toMatchObject({
      kind: 'text',
      content: 'Привет! Чем могу помочь?',
    })
    expect(messagesCreate).toHaveBeenCalledTimes(1)
  })

  test('propose_meal: persists text + food_card, ONE LLM call (no follow-up)', async () => {
    const userId = crypto.randomUUID()

    const proposalInput = {
      meal: 'Lunch',
      foodName: 'Куриная грудка с макаронами',
      emoji: '🍝',
      calories: 620,
      protein: 50,
      carbs: 65,
      fats: 12,
    }

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          { type: 'text', text: 'Прикинул порции на ~620 ккал.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'propose_meal',
            input: proposalInput,
          },
        ],
        stop_reason: 'tool_use',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(userId), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'это курица и макароны' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      ai: Array<{ kind: string; content: string; meta: unknown }>
    }
    expect(body.ai).toHaveLength(2)
    expect(body.ai[0]).toMatchObject({ kind: 'text' })
    expect(body.ai[1]).toMatchObject({ kind: 'food_card' })
    expect(body.ai[1].meta).toMatchObject(proposalInput)

    // The whole point of breaking after a proposal: NO second round-trip.
    expect(messagesCreate).toHaveBeenCalledTimes(1)

    // No meal row should exist yet — propose_meal only writes a card.
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(0)
  })
})

describe('POST /chat/confirm', () => {
  const FOOD_META = {
    meal: 'Lunch',
    foodName: 'Куриная грудка с макаронами',
    emoji: '🍝',
    calories: 620,
    protein: 50,
    carbs: 65,
    fats: 12,
  }

  test('food_card accept: writes meal, inserts confirm, runs analysis with READ_ONLY_TOOLS', async () => {
    const userId = await seedUser()
    const cardId = await seedFoodCard(userId, FOOD_META)

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'text',
            text: 'Отлично, осталось ~800 ккал. На ужин — творог с зеленью.',
          },
        ],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat/confirm', {
        method: 'POST',
        headers: { ...authHeaders(userId), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatMessageId: cardId, accepted: true }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      confirm: { kind: string; meta: { accepted: boolean; ref: string } }
      ai: Array<{ kind: string; content: string }>
      meal: { foodName: string; calories: number }
    }

    expect(body.meal).toMatchObject({
      foodName: FOOD_META.foodName,
      calories: FOOD_META.calories,
    })
    expect(body.confirm.kind).toBe('confirm')
    expect(body.confirm.meta).toMatchObject({ accepted: true, ref: cardId })
    expect(body.ai).toHaveLength(1)
    expect(body.ai[0].content).toContain('осталось')

    expect(messagesCreate).toHaveBeenCalledTimes(1)

    // The follow-up turn must NOT be allowed to spawn another card.
    const callArg = messagesCreate.mock.calls[0]?.[0] as { tools: Array<{ name: string }> }
    const toolNames = callArg.tools.map((t) => t.name).sort()
    expect(toolNames).toEqual(['get_goal_for_day', 'get_meals_for_day'])

    // Real meal row landed in DB.
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(1)
    expect(mealRows[0]).toMatchObject({ foodName: FOOD_META.foodName })
  })

  test('food_card reject: confirm only, NO LLM call, no meal row', async () => {
    const userId = await seedUser()
    const cardId = await seedFoodCard(userId, FOOD_META)

    const res = await makeApp().fetch(
      new Request('http://x/chat/confirm', {
        method: 'POST',
        headers: { ...authHeaders(userId), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatMessageId: cardId,
          accepted: false,
          note: 'там было меньше',
        }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      confirm: { kind: string; meta: { accepted: boolean; note: string } }
      ai: unknown[]
      meal?: unknown
    }

    expect(body.confirm.kind).toBe('confirm')
    expect(body.confirm.meta).toMatchObject({
      accepted: false,
      note: 'там было меньше',
    })
    expect(body.ai).toHaveLength(0)
    expect(body.meal).toBeUndefined()

    expect(messagesCreate).not.toHaveBeenCalled()

    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(0)

    // The confirm row IS in chat history.
    const confirmRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
    expect(confirmRows.some((r) => r.kind === 'confirm')).toBe(true)
  })

  test('food_card with bad meta returns 422 and does not write meal', async () => {
    const userId = await seedUser()
    // Missing required fields (calories etc.)
    const cardId = await seedFoodCard(userId, { foodName: 'Just a name' })

    const res = await makeApp().fetch(
      new Request('http://x/chat/confirm', {
        method: 'POST',
        headers: { ...authHeaders(userId), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatMessageId: cardId, accepted: true }),
      }),
    )

    expect(res.status).toBe(422)
    expect(messagesCreate).not.toHaveBeenCalled()

    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(0)
  })
})
