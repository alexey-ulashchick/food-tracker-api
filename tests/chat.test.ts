import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import { chatMessages, dailyGoals, meals } from '../src/db/schema.ts'
import {
  type SseEvent,
  authHeaders,
  llmResponse,
  makeApp,
  readSse,
  seedGoal,
  seedMeal,
  seedUser,
  streamRequest,
  truncateAll,
} from './helpers.ts'
import { messagesCreate } from './setup.ts'

beforeEach(async () => {
  await truncateAll()
  messagesCreate.mockReset()
})

describe('POST /chat', () => {
  test('text-only: 1 LLM call, 1 ai text row', async () => {
    const { userId, token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Привет! Чем могу помочь?' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
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

  test('add_meal: writes meal row, persists action card + recap text', async () => {
    const { userId, token } = await seedUser()

    const addInput = {
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
          { type: 'tool_use', id: 'toolu_1', name: 'add_meal', input: addInput },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Записал. Осталось ~600 ккал на день.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'это курица и макароны' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      ai: Array<{ kind: string; content: string; meta: Record<string, unknown> | null }>
    }

    expect(body.ai).toHaveLength(3)
    expect(body.ai[0]).toMatchObject({ kind: 'text' })
    expect(body.ai[1]).toMatchObject({ kind: 'meal_added' })
    expect(body.ai[1].meta).toMatchObject({
      meal: { foodName: addInput.foodName, calories: addInput.calories },
    })
    expect(body.ai[2]).toMatchObject({ kind: 'text' })
    expect(body.ai[2].content).toContain('Осталось')

    // Two LLM calls: initial tool_use, then recap after we fed the result back.
    expect(messagesCreate).toHaveBeenCalledTimes(2)

    // The meal row landed in the DB.
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(1)
    expect(mealRows[0]).toMatchObject({ foodName: addInput.foodName })
  })

  test('update_meal: edits row in place and logs meal_updated card', async () => {
    const { userId, token } = await seedUser()
    const seeded = await seedMeal(userId, {
      foodName: 'Овсяное печенье',
      calories: 200,
      protein: 3,
      carbs: 30,
      fats: 7,
      meal: 'Snack',
    })

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_u',
            name: 'update_meal',
            input: { id: seeded.id, calories: 300, fats: 12 },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Поправил, теперь 300 ккал.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'оно было больше, ккал на 300' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      ai: Array<{ kind: string; meta: Record<string, unknown> | null }>
    }

    const updateCard = body.ai.find((m) => m.kind === 'meal_updated')
    expect(updateCard).toBeDefined()
    expect(updateCard?.meta).toMatchObject({
      mealId: seeded.id,
      before: { calories: 200 },
      after: { calories: 300 },
    })

    // Only one row in meals — it was updated, not duplicated.
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(1)
    expect(mealRows[0]).toMatchObject({ calories: 300, fats: 12, protein: 3 })
  })

  test('delete_meal: removes row and logs meal_removed card', async () => {
    const { userId, token } = await seedUser()
    const seeded = await seedMeal(userId, { foodName: 'Печенье', calories: 200 })

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_d',
            name: 'delete_meal',
            input: { id: seeded.id },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Удалил.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'не, я не ел печенье' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      ai: Array<{ kind: string; meta: Record<string, unknown> | null }>
    }

    const removeCard = body.ai.find((m) => m.kind === 'meal_removed')
    expect(removeCard).toBeDefined()
    expect(removeCard?.meta).toMatchObject({
      mealId: seeded.id,
      meal: { foodName: 'Печенье' },
    })

    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(0)
  })

  test('set_goal: upserts goal and logs goal_set card', async () => {
    const { userId, token } = await seedUser()

    const goalInput = {
      date: '2026-06-17',
      dayType: 'training',
      calorieGoal: 2600,
      proteinGGoal: 180,
      carbsGGoal: 280,
      fatGGoal: 80,
    }

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'tool_use', id: 'toolu_g', name: 'set_goal', input: goalInput }],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Поставил 2600 ккал на сегодня.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'сегодня тренировочный, поставь 2600' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      ai: Array<{ kind: string; meta: Record<string, unknown> | null }>
    }
    const goalCard = body.ai.find((m) => m.kind === 'goal_set')
    expect(goalCard).toBeDefined()
    expect(goalCard?.meta).toMatchObject({ goal: { calorieGoal: 2600, dayType: 'training' } })

    const goalRows = await db.select().from(dailyGoals).where(eq(dailyGoals.userId, userId))
    expect(goalRows).toHaveLength(1)
    expect(goalRows[0]).toMatchObject({ calorieGoal: 2600, dayType: 'training' })
  })

  test('failed write tool: error fed back, no action card persisted', async () => {
    const { userId, token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bad',
            name: 'delete_meal',
            input: { id: '00000000-0000-0000-0000-000000000000' },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Не нашёл такой записи.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'удали последнюю еду' }),
      }),
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as { ai: Array<{ kind: string }> }

    expect(body.ai.some((m) => m.kind === 'meal_removed')).toBe(false)
    const allRows = await db.select().from(chatMessages).where(eq(chatMessages.userId, userId))
    expect(allRows.some((r) => r.kind === 'meal_removed')).toBe(false)

    // The second call should have received an error tool_result.
    const secondCall = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]!
    expect(lastMsg.role).toBe('user')
    const toolResult = (lastMsg.content as Array<{ is_error?: boolean }>)[0]!
    expect(toolResult.is_error).toBe(true)
  })

  test('read tool then write tool: looks up id via get_meals_for_day, then deletes', async () => {
    const { userId, token } = await seedUser()
    const seeded = await seedMeal(userId, { foodName: 'Vacant lookup' })
    // seedGoal not needed; just keep user clean

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_r',
            name: 'get_meals_for_day',
            input: { date: new Date().toISOString().slice(0, 10) },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_d2',
            name: 'delete_meal',
            input: { id: seeded.id },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Удалил.' }],
        stop_reason: 'end_turn',
      }),
    )

    await seedGoal(userId)
    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'удали последнюю запись' }),
      }),
    )

    expect(res.status).toBe(201)
    expect(messagesCreate).toHaveBeenCalledTimes(3)
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(0)
  })

  test('add_meal stamps the request TZ when input omits tzOffsetMin', async () => {
    const { userId, token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'add_meal',
            input: {
              meal: 'Breakfast',
              foodName: 'Овсянка',
              calories: 300,
              protein: 12,
              carbs: 50,
              fats: 6,
            },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Готово.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
          'Content-Type': 'application/json',
          'X-Client-TZ-Offset': '180', // Moscow
        },
        body: JSON.stringify({ content: 'овсянка' }),
      }),
    )

    expect(res.status).toBe(201)
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows).toHaveLength(1)
    expect(mealRows[0]?.tzOffsetMin).toBe(180)
  })

  test('add_meal honours an explicit tzOffsetMin in tool input', async () => {
    const { userId, token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_a2',
            name: 'add_meal',
            input: {
              meal: 'Dinner',
              foodName: 'Стейк',
              calories: 700,
              protein: 60,
              carbs: 0,
              fats: 50,
              tzOffsetMin: -300, // NY — overrides the request's Moscow header
            },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Записал.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: {
          ...authHeaders(token),
          'Content-Type': 'application/json',
          'X-Client-TZ-Offset': '180',
        },
        body: JSON.stringify({ content: 'ел стейк в нью-йорке' }),
      }),
    )

    expect(res.status).toBe(201)
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows[0]?.tzOffsetMin).toBe(-300)
  })

  test('update_meal can change tz_offset_min', async () => {
    const { userId, token } = await seedUser()
    const seeded = await seedMeal(userId, { tzOffsetMin: 180 })

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_uz',
            name: 'update_meal',
            input: { id: seeded.id, tzOffsetMin: -300 },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Поправил TZ.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'это было в нью-йорке' }),
      }),
    )

    expect(res.status).toBe(201)
    const mealRows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(mealRows[0]?.tzOffsetMin).toBe(-300)
  })

  test('after a write, the tool_result carries a fresh todaysTotals snapshot', async () => {
    const { token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_t',
            name: 'add_meal',
            input: {
              meal: 'Breakfast',
              foodName: 'Овсянка',
              calories: 300,
              protein: 12,
              carbs: 50,
              fats: 6,
            },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Записал.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'овсянка' }),
      }),
    )
    expect(res.status).toBe(201)

    const secondCall = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]!
    expect(lastMsg.role).toBe('user')
    const toolResult = (lastMsg.content as Array<{ content: string; is_error?: boolean }>)[0]!
    expect(toolResult.is_error).toBeFalsy()
    const parsed = JSON.parse(toolResult.content) as {
      todaysTotals?: { eaten?: { calories?: number } }
    }
    expect(parsed.todaysTotals).toBeDefined()
    expect(parsed.todaysTotals?.eaten?.calories).toBe(300)
  })

  test('history from a previous day is kept but tagged with a day-boundary marker', async () => {
    const { userId, token } = await seedUser()

    // Two rows are needed, not one: historyToMessages annotates a row only
    // when its local date differs from the PREVIOUS row's, and the very first
    // row has no predecessor. The current turn's message is appended after
    // that pass, so it can never carry the marker either — with a single
    // yesterday row there is simply no boundary to mark.
    const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000)
    await db.insert(chatMessages).values({
      userId,
      role: 'ai',
      kind: 'text',
      content: 'YESTERDAY_RECAP',
      createdAt: yesterday,
    })
    await db.insert(chatMessages).values({
      userId,
      role: 'user',
      kind: 'text',
      content: 'TODAY_FIRST',
      createdAt: new Date(),
    })

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'привет' }),
      }),
    )
    expect(res.status).toBe(201)

    const firstCall = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const flat = JSON.stringify(firstCall.messages)
    // The yesterday row survives — context like "как вчера" still works.
    expect(flat).toContain('YESTERDAY_RECAP')
    // The first row of the new day is annotated so the model knows yesterday's
    // budget numbers don't apply to the current turn.
    expect(flat).toContain('Day boundary')
    const todayMessage = firstCall.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('TODAY_FIRST'),
    )
    expect(String(todayMessage?.content)).toContain('Day boundary')
  })

  test('history confined to one day carries no boundary marker', async () => {
    const { userId, token } = await seedUser()

    await db.insert(chatMessages).values({
      userId,
      role: 'user',
      kind: 'text',
      content: 'FIRST',
      createdAt: new Date(),
    })
    await db.insert(chatMessages).values({
      userId,
      role: 'ai',
      kind: 'text',
      content: 'SECOND',
      createdAt: new Date(),
    })

    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    )
    await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'привет' }),
      }),
    )

    const firstCall = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(JSON.stringify(firstCall.messages)).not.toContain('Day boundary')
  })

  test('iteration cap: bulk tool calls run to completion, then a forced wrap-up recap is persisted', async () => {
    const { userId, token } = await seedUser()

    // 20 back-to-back set_goal turns that never stop asking for tools — the
    // "выставь цели на 30 дней" shape. The loop must run all 20 iterations
    // (writing every goal) instead of bailing after the first few.
    for (let i = 0; i < 20; i++) {
      const date = `2026-07-${String(i + 1).padStart(2, '0')}`
      messagesCreate.mockResolvedValueOnce(
        llmResponse({
          content: [
            {
              type: 'tool_use',
              id: `toolu_g${i}`,
              name: 'set_goal',
              input: {
                date,
                dayType: 'rest',
                calorieGoal: 2000,
                proteinGGoal: 150,
                carbsGGoal: 200,
                fatGGoal: 60,
              },
            },
          ],
          stop_reason: 'tool_use',
        }),
      )
    }
    // The 21st call is the tools-off wrap-up the loop forces once it hits the
    // iteration ceiling.
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Выставил 20 дней, по остальным скажи — продолжу.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'выставь цели на 30 дней' }),
      }),
    )

    expect(res.status).toBe(201)

    // 20 loop iterations + 1 forced wrap-up.
    expect(messagesCreate).toHaveBeenCalledTimes(21)

    // Every goal from the batch actually landed — no silent stop mid-way.
    const goalRows = await db.select().from(dailyGoals).where(eq(dailyGoals.userId, userId))
    expect(goalRows).toHaveLength(20)

    // The turn ends with a text recap, not silence after a stack of cards.
    const body = (await res.json()) as { ai: Array<{ kind: string; content: string }> }
    const lastAi = body.ai[body.ai.length - 1]!
    expect(lastAi.kind).toBe('text')
    expect(lastAi.content).toContain('продолж')

    // The forced wrap-up call disabled tools and carried the limit note.
    const wrapCall = messagesCreate.mock.calls[20]?.[0] as { tools?: unknown; system: string }
    expect(wrapCall.tools).toBeUndefined()
    expect(wrapCall.system).toContain('SYSTEM NOTE')
  })

  test('list_meals: pages back through history so the model can find an older dish itself', async () => {
    const { userId, token } = await seedUser()
    const day = 86_400_000
    await seedMeal(userId, {
      foodName: 'Овсянка с бананом',
      timestamp: new Date(Date.now() - 1 * day),
    })
    const oldMeal = await seedMeal(userId, {
      foodName: 'Плов с бараниной',
      timestamp: new Date(Date.now() - 12 * day),
    })

    const today = new Date().toISOString().slice(0, 10)
    const tenDaysAgo = new Date(Date.now() - 10 * day).toISOString().slice(0, 10)

    // Page 1: default window (last 5 days) — recent meal only.
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'tool_use', id: 'toolu_p1', name: 'list_meals', input: {} }],
        stop_reason: 'tool_use',
      }),
    )
    // Page 2: model pages back to a window that covers the 12-day-old meal.
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_p2',
            name: 'list_meals',
            input: { endDate: tenDaysAgo, days: 5 },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Нашёл: плов с бараниной, ~12 дней назад.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'что там было похожее на плов пару недель назад?' }),
      }),
    )

    expect(res.status).toBe(201)
    expect(messagesCreate).toHaveBeenCalledTimes(3)

    // Page 1 result (fed into call 2): recent window, old meal NOT yet visible,
    // but hasOlder tells the model to keep paging.
    const call2 = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const page1Msg = call2.messages[call2.messages.length - 1]!
    const page1 = JSON.parse((page1Msg.content as Array<{ content: string }>)[0]!.content) as {
      data: {
        window: { to: string }
        meals: Array<{ foodName: string }>
        hasOlder: boolean
        olderThan: string
      }
    }
    expect(page1.data.window.to).toBe(today)
    expect(page1.data.hasOlder).toBe(true)
    expect(page1.data.meals.some((m) => m.foodName === 'Плов с бараниной')).toBe(false)

    // Page 2 result (fed into call 3): the older window surfaces the plov.
    const call3 = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const page2Msg = call3.messages[call3.messages.length - 1]!
    const page2 = JSON.parse((page2Msg.content as Array<{ content: string }>)[0]!.content) as {
      data: { meals: Array<{ id: string; foodName: string }> }
    }
    expect(page2.data.meals.some((m) => m.id === oldMeal.id)).toBe(true)
  })
})

// ─── POST /chat/stream ──────────────────────────────────────────────────────
// Same tool loop, same guards, same persistence as POST /chat — the tests
// below only assert the streaming surface on top of it. The mocked SDK pulls
// its final message from the same messagesCreate queue for both entry points
// (see tests/setup.ts), so a scripted turn behaves identically either way.

describe('POST /chat/stream', () => {
  const names = (events: SseEvent[]) => events.map((e) => e.event)
  const deltaText = (events: SseEvent[]) =>
    events
      .filter((e) => e.event === 'delta')
      .map((e) => e.data.text as string)
      .join('')

  test('text-only turn: user → delta* → message → usage → done', async () => {
    const { token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Привет! Чем могу помочь?' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(streamRequest(token, 'привет'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const events = await readSse(res)
    expect(names(events)[0]).toBe('user')
    expect(names(events).at(-1)).toBe('done')
    expect(names(events)).toContain('usage')

    // Text really arrives in pieces, not as one blob.
    expect(events.filter((e) => e.event === 'delta').length).toBeGreaterThan(1)
    expect(deltaText(events)).toBe('Привет! Чем могу помочь?')

    const message = events.find((e) => e.event === 'message')
    expect(message?.data.blockId).toBe('0-0')
    expect((message?.data.row as { content: string }).content).toBe('Привет! Чем могу помочь?')
  })

  test('the message frame lands after the deltas it supersedes', async () => {
    const { token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'a'.repeat(40) }], stop_reason: 'end_turn' }),
    )

    const n = names(await readSse(await makeApp().fetch(streamRequest(token, 'hi'))))
    expect(n.lastIndexOf('delta')).toBeLessThan(n.indexOf('message'))
  })

  test('the persisted user row is emitted before the model runs', async () => {
    const { token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'ок' }], stop_reason: 'end_turn' }),
    )

    const events = await readSse(await makeApp().fetch(streamRequest(token, 'первое сообщение')))
    expect(events[0]?.event).toBe('user')
    expect((events[0]?.data as { content: string }).content).toBe('первое сообщение')
  })

  test('a write tool reports start then ok and yields a card', async () => {
    const { userId, token } = await seedUser()
    await seedGoal(userId, { date: new Date().toISOString().slice(0, 10) })

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'add_meal',
            input: {
              meal: 'Lunch',
              emoji: '🍎',
              foodName: 'Яблоко',
              calories: 95,
              protein: 0,
              carbs: 25,
              fats: 0,
            },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Записал' }], stop_reason: 'end_turn' }),
    )

    const events = await readSse(await makeApp().fetch(streamRequest(token, 'съел яблоко')))

    const tools = events.filter((e) => e.event === 'tool')
    expect(tools.map((t) => t.data.status)).toEqual(['start', 'ok'])
    expect(tools[0]?.data.name).toBe('add_meal')

    const card = events.find((e) => e.event === 'card')
    expect((card?.data as { kind: string }).kind).toBe('meal_added')

    // The meal really landed, exactly as it would through POST /chat.
    const rows = await db.select().from(meals).where(eq(meals.userId, userId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.foodName).toBe('Яблоко')
  })

  test('a failing tool reports status error and emits no card', async () => {
    const { token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          // No such meal id — executeTool comes back { ok: false }.
          {
            type: 'tool_use',
            id: 't1',
            name: 'delete_meal',
            input: { mealId: '00000000-0000-0000-0000-000000000000' },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Не нашёл' }], stop_reason: 'end_turn' }),
    )

    const events = await readSse(await makeApp().fetch(streamRequest(token, 'удали обед')))

    expect(events.filter((e) => e.event === 'tool').at(-1)?.data.status).toBe('error')
    expect(names(events)).not.toContain('card')
  })

  // The write-claim guard can only decide once every tool has run, by which
  // point the false line is already on the user's screen. That is the entire
  // reason `retract` exists.
  test('an unbacked write claim is streamed, then retracted and never persisted', async () => {
    const { userId, token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Записал творог' }], stop_reason: 'end_turn' }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Уточни порцию, пожалуйста' }],
        stop_reason: 'end_turn',
      }),
    )

    const events = await readSse(await makeApp().fetch(streamRequest(token, 'запиши творог')))

    const retract = events.find((e) => e.event === 'retract')
    expect(retract).toBeDefined()
    expect(retract?.data.blockIds).toEqual(['0-0'])
    // It must cancel deltas the client has already rendered, so it comes last.
    expect(names(events).indexOf('retract')).toBeGreaterThan(names(events).indexOf('delta'))

    const rows = await db.select().from(chatMessages).where(eq(chatMessages.userId, userId))
    const aiText = rows.filter((r) => r.role === 'ai').map((r) => r.content)
    expect(aiText).not.toContain('Записал творог')
    expect(aiText).toContain('Уточни порцию, пожалуйста')
  })

  test('a claim backed by a real write is not retracted', async () => {
    const { userId, token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          { type: 'text', text: 'Записал творог' },
          {
            type: 'tool_use',
            id: 't1',
            name: 'add_meal',
            input: {
              meal: 'Breakfast',
              emoji: '🥛',
              foodName: 'Творог',
              calories: 180,
              protein: 30,
              carbs: 6,
              fats: 4,
            },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Готово' }], stop_reason: 'end_turn' }),
    )

    const events = await readSse(await makeApp().fetch(streamRequest(token, 'запиши творог')))
    expect(names(events)).not.toContain('retract')

    const rows = await db.select().from(chatMessages).where(eq(chatMessages.userId, userId))
    expect(rows.filter((r) => r.role === 'ai').map((r) => r.content)).toContain('Записал творог')
  })

  test('usage is stamped on the last ai row and reported once', async () => {
    const { token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'ок' }], stop_reason: 'end_turn' }),
    )

    const events = await readSse(await makeApp().fetch(streamRequest(token, 'привет')))
    const usage = events.filter((e) => e.event === 'usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]!.data).toHaveProperty('messageId')
    expect(usage[0]!.data).toHaveProperty('costUsd')
  })

  test('a photo thumbnail is persisted on the streamed user row', async () => {
    const { userId, token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Вижу' }], stop_reason: 'end_turn' }),
    )

    const thumb = 'data:image/webp;base64,UklGRg=='
    const form = new FormData()
    form.set('content', 'что это?')
    form.set('image', new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' }))
    form.set('thumb', thumb)
    const res = await makeApp().fetch(
      new Request('http://x/chat/stream', {
        method: 'POST',
        headers: authHeaders(token),
        body: form,
      }),
    )

    await readSse(res)
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.userId, userId))
    const userRow = rows.find((r) => r.role === 'user')
    expect(userRow?.meta).toMatchObject({ hadImage: true, mediaType: 'image/png', thumb })
  })

  // Validation has to happen before streamSSE takes over the response, or the
  // status is already 200 and the error is unreportable.
  test('an invalid body 400s as JSON instead of opening a stream', async () => {
    const { token } = await seedUser()
    const res = await makeApp().fetch(streamRequest(token, ''))
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  test('an LLM failure closes the stream with an error frame', async () => {
    const { token } = await seedUser()
    messagesCreate.mockRejectedValueOnce(new Error('upstream exploded'))

    const events = await readSse(await makeApp().fetch(streamRequest(token, 'привет')))
    const error = events.find((e) => e.event === 'error')
    expect(error?.data.code).toBe('internal')
    expect(String(error?.data.message)).toContain('upstream exploded')
  })
})

describe('empty thinking blocks from the pinned SDK', () => {
  // @anthropic-ai/sdk 0.30.1 has no `thinking_delta` case in its stream
  // accumulator, so a streamed thinking block reaches finalMessage() with
  // `thinking: ''`. Handing that back to the next iteration fails the whole
  // request with "each thinking block must contain thinking", which strands a
  // bulk turn after its earlier writes have already committed.
  test('an empty one is not fed back into the next iteration', async () => {
    const { userId, token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          {
            type: 'tool_use',
            id: 'toolu_goal',
            name: 'set_goal',
            input: {
              date: '2026-09-09',
              dayType: 'rest',
              calorieGoal: 1450,
              proteinGGoal: 140,
              carbsGGoal: 88,
              fatGGoal: 60,
            },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [{ type: 'text', text: 'Цель на 9 сентября выставил.' }],
        stop_reason: 'end_turn',
      }),
    )

    const res = await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'цель на среду 1450' }),
      }),
    )
    expect(res.status).toBe(201)

    const secondCall = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const assistantTurn = secondCall.messages.find((m) => m.role === 'assistant')
    const blocks = assistantTurn?.content as Array<{ type: string }>

    expect(blocks.some((b) => b.type === 'thinking')).toBe(false)
    // The tool_use it preceded still has to survive, or the tool_result that
    // follows has nothing to answer.
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true)

    const goalRows = await db.select().from(dailyGoals).where(eq(dailyGoals.userId, userId))
    expect(goalRows).toHaveLength(1)
  })

  test('a populated one is passed through untouched', async () => {
    const { token } = await seedUser()

    const thinking = { type: 'thinking', thinking: 'Считаю остаток на день.', signature: 'sig-1' }
    messagesCreate.mockResolvedValueOnce(
      llmResponse({
        content: [
          thinking,
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'get_meals_for_day',
            input: { date: '2026-09-09' },
          },
        ],
        stop_reason: 'tool_use',
      }),
    )
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Пока пусто.' }], stop_reason: 'end_turn' }),
    )

    await makeApp().fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'что я ел в среду' }),
      }),
    )

    const secondCall = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const assistantTurn = secondCall.messages.find((m) => m.role === 'assistant')
    // Signature verification depends on the block surviving byte for byte.
    expect(assistantTurn?.content).toContainEqual(thinking)
  })
})

describe('time to first byte on a cold database', () => {
  // Six queries used to run before the stream opened: the token lookup in auth,
  // four in fetchChatContext, and the user-row insert. Neon and this machine both
  // scale to zero, so on a cold start that was seconds in which the client held a
  // request that had produced nothing at all — no headers, no body — and the
  // heartbeat could not help because it only starts once the stream is open.
  // Those connections were being dropped in transit.
  test('the first frame precedes the context load', async () => {
    const { token } = await seedUser()

    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Привет.' }], stop_reason: 'end_turn' }),
    )

    const res = await makeApp().fetch(streamRequest(token, 'привет'))
    expect(res.status).toBe(200)

    const body = await res.text()
    // A comment frame is the cheapest thing that commits the response headers.
    expect(body.startsWith(':')).toBe(true)
    // And it is genuinely first — ahead of the persisted user row.
    expect(body.indexOf(':')).toBeLessThan(body.indexOf('event: user'))
  })

  test('/chat/recommend opens the same way', async () => {
    const { token } = await seedUser()

    const res = await makeApp().fetch(
      new Request('http://x/chat/recommend', { method: 'POST', headers: authHeaders(token) }),
    )
    expect(res.status).toBe(200)
    expect((await res.text()).startsWith(':')).toBe(true)
  })
})
