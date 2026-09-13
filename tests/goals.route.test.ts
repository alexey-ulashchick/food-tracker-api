import { beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../src/db/client.ts'
import { dailyGoals } from '../src/db/schema.ts'
import { goalsRoute } from '../src/routes/goals.ts'
import { authHeaders, seedGoal, seedUser, truncateAll } from './helpers.ts'

// The route had no test file at all until DELETE arrived with the goals
// screen. What matters most here is the provenance stamp: PATCH is a human
// writer, so it has to mark the row 'manual' or POST /training/sync will
// recompute over the top of it on the next refresh.

function makeApp() {
  return new Hono().route('/goals', goalsRoute)
}

async function patch(token: string, body: unknown) {
  return makeApp().fetch(
    new Request('http://x/goals', {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function del(token: string, date: string) {
  return makeApp().fetch(
    new Request(`http://x/goals/${date}`, { method: 'DELETE', headers: authHeaders(token) }),
  )
}

type GoalBody = {
  source: string
  breakdown: unknown
  calorieGoal: number
}

const FULL = {
  date: '2026-09-13',
  dayType: 'training' as const,
  calorieGoal: 2450,
  proteinGGoal: 140,
  carbsGGoal: 298,
  fatGGoal: 60,
}

beforeEach(async () => {
  await truncateAll()
})

describe('PATCH /goals', () => {
  test('marks the row as manual', async () => {
    const { token } = await seedUser()
    const body = (await (await patch(token, FULL)).json()) as GoalBody
    expect(body.source).toBe('manual')
  })

  test('taking over an automatic day clears its breakdown', async () => {
    // Otherwise the goals screen would show a derivation that no longer
    // explains the number sitting next to it.
    const { token, userId } = await seedUser()
    await seedGoal(userId, {
      date: FULL.date,
      source: 'auto',
      breakdown: { base: 1450, strength: 250, rides: [] },
    })

    const body = (await (await patch(token, FULL)).json()) as GoalBody
    expect(body.source).toBe('manual')
    expect(body.breakdown).toBeNull()
    expect(body.calorieGoal).toBe(2450)
  })
})

describe('GET /goals', () => {
  test('carries the source and the breakdown to the client', async () => {
    const { token, userId } = await seedUser()
    await seedGoal(userId, {
      date: '2026-09-12',
      source: 'auto',
      breakdown: { base: 1450, strength: 250, rides: [] },
    })

    const rows = (await (
      await makeApp().fetch(new Request('http://x/goals', { headers: authHeaders(token) }))
    ).json()) as GoalBody[]
    expect(rows[0]?.source).toBe('auto')
    expect(rows[0]?.breakdown).toEqual({ base: 1450, strength: 250, rides: [] })
  })
})

describe('DELETE /goals/:date', () => {
  test('removes the day and acknowledges it', async () => {
    const { token, userId } = await seedUser()
    const goal = await seedGoal(userId, { date: '2026-09-13' })

    const res = await del(token, '2026-09-13')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, id: goal.id })

    const left = await db.select().from(dailyGoals).where(eq(dailyGoals.userId, userId))
    expect(left).toHaveLength(0)
  })

  test('leaves the other days alone', async () => {
    const { token, userId } = await seedUser()
    await seedGoal(userId, { date: '2026-09-12' })
    await seedGoal(userId, { date: '2026-09-13' })

    await del(token, '2026-09-13')
    const left = await db.select().from(dailyGoals).where(eq(dailyGoals.userId, userId))
    expect(left.map((r) => r.date)).toEqual(['2026-09-12'])
  })

  test('404s a day that has no goal', async () => {
    const { token } = await seedUser()
    expect((await del(token, '2026-09-13')).status).toBe(404)
  })

  test('400s a date that is not a date', async () => {
    const { token } = await seedUser()
    expect((await del(token, 'yesterday')).status).toBe(400)
  })

  test('cannot delete another user goal', async () => {
    const a = await seedUser()
    const b = await seedUser()
    await seedGoal(b.userId, { date: '2026-09-13' })

    expect((await del(a.token, '2026-09-13')).status).toBe(404)
    const left = await db
      .select()
      .from(dailyGoals)
      .where(and(eq(dailyGoals.userId, b.userId), eq(dailyGoals.date, '2026-09-13')))
    expect(left).toHaveLength(1)
  })

  test('rejects a request with no Authorization header', async () => {
    const res = await makeApp().fetch(
      new Request('http://x/goals/2026-09-13', { method: 'DELETE' }),
    )
    expect(res.status).toBe(401)
  })
})
