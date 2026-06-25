import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import { chatMessages, dailyGoals } from '../src/db/schema.ts'
import {
  authHeaders,
  makeApp,
  seedGoal,
  seedMeal,
  seedUser,
  truncateAll,
} from './helpers.ts'

beforeEach(async () => {
  await truncateAll()
})

// Server uses `today = new Date(Date.now() + offset*60_000).toISOString().slice(0,10)`.
// With no X-Client-TZ-Offset header offset=0, so the test's "today" is the
// UTC date — match it when seeding goals.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

type SSEEvent = { event: string; data: unknown }

async function readSSE(res: Response): Promise<SSEEvent[]> {
  const text = await res.text()
  const events: SSEEvent[] = []
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue
    let name = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!name) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      parsed = data
    }
    events.push({ event: name, data: parsed })
  }
  return events
}

describe('POST /chat/recommend', () => {
  test('emits an error event when no daily goal is set for today', async () => {
    const { token } = await seedUser()
    // No goal seeded for today.
    const res = await makeApp().fetch(
      new Request('http://x/chat/recommend', {
        method: 'POST',
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(200)
    const events = await readSSE(res)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('error')
    expect((events[0]!.data as { code: string }).code).toBe('no_goal')
  })

  test('persists user "/recommend" row + one chat row per achievable color', async () => {
    const { userId, token } = await seedUser()
    await seedGoal(userId, {
      date: todayUtc(),
      calorieGoal: 2000,
      proteinGGoal: 150,
      carbsGGoal: 200,
      fatGGoal: 60,
    })
    // Today's intake — current is yellow (protein at 80% of goal).
    await seedMeal(userId, {
      foodName: "Today's lunch",
      calories: 1500,
      protein: 120,
      fats: 30,
      carbs: 150,
      timestamp: new Date(),
    })
    // History food that can land us in green.
    await seedMeal(userId, {
      foodName: 'Protein boost',
      calories: 400,
      protein: 25,
      fats: 30,
      carbs: 50,
      timestamp: new Date(Date.now() - 86_400_000),
    })

    const res = await makeApp().fetch(
      new Request('http://x/chat/recommend', {
        method: 'POST',
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(200)
    const events = await readSSE(res)

    // user → at least one recommend → done.
    expect(events[0]!.event).toBe('user')
    expect((events[0]!.data as { content: string }).content).toBe('/recommend')
    const recommendEvents = events.filter((e) => e.event === 'recommend')
    expect(recommendEvents.length).toBeGreaterThanOrEqual(1)
    expect(events.at(-1)!.event).toBe('done')

    // The "/recommend" user row plus each recommend row were persisted.
    const persisted = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
    const recommendRows = persisted.filter((r) => r.kind === 'recommend')
    expect(recommendRows.length).toBe(recommendEvents.length)
    const userRows = persisted.filter((r) => r.role === 'user')
    expect(userRows.length).toBe(1)
    expect(userRows[0]!.content).toBe('/recommend')
  })

  test('persists fallback "no useful combination" text when nothing is reachable', async () => {
    const { userId, token } = await seedUser()
    await seedGoal(userId, {
      date: todayUtc(),
      calorieGoal: 2000,
      proteinGGoal: 150,
      carbsGGoal: 200,
      fatGGoal: 60,
    })
    // Today's intake far under; only candidate food is oversized so the spec
    // filter drops it — engine returns zero recommendations.
    await seedMeal(userId, {
      foodName: 'Sip',
      calories: 50,
      protein: 1,
      fats: 0,
      carbs: 5,
      timestamp: new Date(),
    })
    await seedMeal(userId, {
      foodName: 'Whole feast',
      calories: 5000,
      protein: 100,
      fats: 100,
      carbs: 600,
      timestamp: new Date(Date.now() - 86_400_000),
    })

    const res = await makeApp().fetch(
      new Request('http://x/chat/recommend', {
        method: 'POST',
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(200)
    const events = await readSSE(res)

    expect(events.find((e) => e.event === 'recommend')).toBeUndefined()
    const textEvt = events.find((e) => e.event === 'text')
    expect(textEvt).toBeDefined()
    expect((textEvt!.data as { content: string }).content).toContain('нет полезной комбинации')
  })

  test('current_color=green produces a single empty-combo recommendation row', async () => {
    const { userId, token } = await seedUser()
    await seedGoal(userId, {
      date: todayUtc(),
      calorieGoal: 2000,
      proteinGGoal: 150,
      carbsGGoal: 200,
      fatGGoal: 60,
    })
    // Today's intake lands in green directly.
    await seedMeal(userId, {
      foodName: 'Balanced day',
      calories: 2000,
      protein: 145,
      fats: 55,
      carbs: 200,
      timestamp: new Date(),
    })

    const res = await makeApp().fetch(
      new Request('http://x/chat/recommend', {
        method: 'POST',
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(200)
    const events = await readSSE(res)
    const recs = events.filter((e) => e.event === 'recommend')
    expect(recs).toHaveLength(1)
    const row = recs[0]!.data as { meta: { color: string; foods: unknown[] } }
    expect(row.meta.color).toBe('green')
    expect(row.meta.foods).toHaveLength(0)
  })
})
