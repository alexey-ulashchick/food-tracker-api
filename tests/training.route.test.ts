import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../src/db/client.ts'
import { dailyGoals, userSettings } from '../src/db/schema.ts'
import { clearIntervalsCache } from '../src/integrations/intervals.ts'
import { addDays, todayInOffset } from '../src/lib/clientDate.ts'
import { trainingRoute } from '../src/routes/training.ts'
import { authHeaders, seedGoal, seedUser, truncateAll } from './helpers.ts'

// The rule this suite exists for: a manual goal is never recomputed, and a
// past day is never rewritten. Both are enforced in SQL rather than in JS, so
// both are only observable through the database.

const realFetch = globalThis.fetch

function makeApp() {
  return new Hono().route('/training', trainingRoute)
}

const KEY = 'intervals-key-1234'

async function configure(userId: string, over: Record<string, unknown> = {}) {
  await db
    .insert(userSettings)
    .values({
      userId,
      baseCalories: 1450,
      proteinG: 140,
      fatG: 60,
      intervalsAthleteId: 'i123',
      intervalsApiKey: KEY,
      ...over,
    })
    .onConflictDoNothing()
}

/**
 * Makes intervals.icu answer with exactly these events.
 *
 * Only the events endpoint is counted. A sync also asks for the athlete's FTP,
 * and counting every request would make the cache tests assert how many calls
 * the implementation happens to make rather than whether it cached.
 */
function stubEvents(events: unknown[], ftp = 250): { calls: () => number } {
  let calls = 0
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes('/sport-settings')) {
      return new Response(JSON.stringify([{ types: ['Ride'], ftp }]), { status: 200 })
    }
    calls++
    return new Response(JSON.stringify(events), { status: 200 })
  }) as unknown as typeof fetch
  return { calls: () => calls }
}

function rideOn(date: string, over: Record<string, unknown> = {}) {
  return {
    start_date_local: `${date}T00:00:00`,
    category: 'WORKOUT',
    type: 'Ride',
    name: 'Z2',
    moving_time: 7200,
    joules: 2_000_000,
    workout_doc: { ftp: 250, steps: [{ duration: 7200, power: { units: '%ftp', value: 65 } }] },
    ...over,
  }
}

type SyncBody = {
  configured: boolean
  missing?: string[]
  from?: string
  to?: string
  today?: string
  sessions?: number
  written?: number
  skipped?: number
  error?: string
}

async function sync(token: string, body?: unknown) {
  return makeApp().fetch(
    new Request('http://x/training/sync', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const goalsOf = (userId: string) =>
  db.select().from(dailyGoals).where(eq(dailyGoals.userId, userId))

const goalOn = async (userId: string, date: string) =>
  (
    await db
      .select()
      .from(dailyGoals)
      .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, date)))
  )[0]

const today = () => todayInOffset(0)

beforeEach(async () => {
  await truncateAll()
  clearIntervalsCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
  clearIntervalsCache()
})

describe('when nothing is set up', () => {
  test('reports what is missing instead of failing', async () => {
    const { token } = await seedUser()
    stubEvents([])

    const body = (await (await sync(token)).json()) as SyncBody
    expect(body.configured).toBe(false)
    expect(body.missing).toEqual([
      'baseCalories',
      'proteinG',
      'fatG',
      'intervalsAthleteId',
      'intervalsApiKey',
    ])
  })

  test('names only the empty boxes', async () => {
    const { token, userId } = await seedUser()
    await configure(userId, { intervalsApiKey: null })

    const body = (await (await sync(token)).json()) as SyncBody
    expect(body.missing).toEqual(['intervalsApiKey'])
  })

  test('writes nothing and does not call intervals.icu', async () => {
    const { token, userId } = await seedUser()
    const stub = stubEvents([rideOn(today())])

    await sync(token)
    expect(stub.calls()).toBe(0)
    expect(await goalsOf(userId)).toHaveLength(0)
  })
})

describe('a configured sync', () => {
  test('writes a goal for every day in the window, planned or not', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    stubEvents([])

    const body = (await (await sync(token)).json()) as SyncBody
    expect(body.configured).toBe(true)
    // 42 back + today + 21 forward.
    expect(await goalsOf(userId)).toHaveLength(64)
  })

  test('a day with no session is the base alone, and a rest day', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    stubEvents([])

    await sync(token)
    const row = await goalOn(userId, today())
    expect(row?.calorieGoal).toBe(1450)
    expect(row?.dayType).toBe('rest')
    expect(row?.source).toBe('auto')
    expect(row?.carbsGGoal).toBe(88)
  })

  test('a planned ride raises the target and records how', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const date = addDays(today(), 2)
    stubEvents([rideOn(date)])

    await sync(token)
    const row = await goalOn(userId, date)
    // 2000 kJ of 2 h endurance → 0.80.
    expect(row?.calorieGoal).toBe(1450 + 1600)
    expect(row?.dayType).toBe('training')
    expect(row?.breakdown).toMatchObject({
      base: 1450,
      strength: 0,
      rides: [{ kind: 'z2', coeff: 0.8, kcal: 1600 }],
    })
  })

  test('a strength session adds the flat bonus', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const date = addDays(today(), 1)
    stubEvents([rideOn(date, { type: 'WeightTraining', joules: undefined, name: 'Gym' })])

    await sync(token)
    expect((await goalOn(userId, date))?.calorieGoal).toBe(1700)
  })

  test('counts what it did', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    stubEvents([rideOn(today()), rideOn(addDays(today(), 3))])

    const body = (await (await sync(token)).json()) as SyncBody
    expect(body.sessions).toBe(2)
    // Today plus 21 days ahead.
    expect(body.written).toBe(22)
    expect(body.skipped).toBe(0)
    expect(body.today).toBe(today())
  })

  test('stamps the sync time on the settings row', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    stubEvents([])

    await sync(token)
    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(row?.intervalsSyncedAt).not.toBeNull()
  })
})

describe('a manual goal wins', () => {
  test('a future manual goal is never recomputed', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const date = addDays(today(), 2)
    await seedGoal(userId, { date, calorieGoal: 2450, source: 'manual', dayType: 'training' })
    stubEvents([rideOn(date)])

    const body = (await (await sync(token)).json()) as SyncBody

    const row = await goalOn(userId, date)
    expect(row?.calorieGoal).toBe(2450)
    expect(row?.source).toBe('manual')
    expect(body.skipped).toBe(1)
  })

  test('an automatic neighbour is still refreshed', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const manual = addDays(today(), 2)
    const auto = addDays(today(), 3)
    await seedGoal(userId, { date: manual, calorieGoal: 2450, source: 'manual' })
    stubEvents([rideOn(auto)])

    await sync(token)
    expect((await goalOn(userId, auto))?.calorieGoal).toBe(1450 + 1600)
  })

  test('deleting the override lets the next sync take the day back', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const date = addDays(today(), 2)
    await seedGoal(userId, { date, calorieGoal: 2450, source: 'manual' })
    stubEvents([rideOn(date)])

    await sync(token)
    await db.delete(dailyGoals).where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, date)))
    await sync(token, { force: true })

    const row = await goalOn(userId, date)
    expect(row?.source).toBe('auto')
    expect(row?.calorieGoal).toBe(1450 + 1600)
  })
})

describe('the past is frozen', () => {
  test('an existing automatic row for a past day is left alone', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const past = addDays(today(), -3)

    stubEvents([rideOn(past)])
    await sync(token)
    expect((await goalOn(userId, past))?.calorieGoal).toBe(1450 + 1600)

    // The session is deleted from the plan; the day already happened.
    stubEvents([])
    await sync(token, { force: true })
    expect((await goalOn(userId, past))?.calorieGoal).toBe(1450 + 1600)
  })

  test('a past day with no row at all is still filled in', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const past = addDays(today(), -3)
    stubEvents([rideOn(past)])

    await sync(token)
    expect(await goalOn(userId, past)).toBeDefined()
  })

  test('today is not the past', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)

    stubEvents([])
    await sync(token)
    expect((await goalOn(userId, today()))?.calorieGoal).toBe(1450)

    stubEvents([rideOn(today())])
    await sync(token, { force: true })
    expect((await goalOn(userId, today()))?.calorieGoal).toBe(1450 + 1600)
  })
})

describe('upstream failures', () => {
  test('a rejected key is a 502, never a 401', async () => {
    // A 401 would make the browser API client throw away this app's own
    // bearer token over intervals.icu refusing someone else's key.
    const { token, userId } = await seedUser()
    await configure(userId)
    globalThis.fetch = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch

    const res = await sync(token)
    expect(res.status).toBe(502)
    expect(((await res.json()) as SyncBody).error).toContain('rejected the credentials')
  })

  test('nothing is written when the fetch fails', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch

    await sync(token)
    expect(await goalsOf(userId)).toHaveLength(0)
  })

  test('the key never appears in the error', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch

    const raw = await (await sync(token)).text()
    expect(raw).not.toContain(KEY)
  })
})

describe('the cache and the refresh button', () => {
  test('a second sync reuses the cached response', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const stub = stubEvents([])

    await sync(token)
    await sync(token)
    expect(stub.calls()).toBe(1)
  })

  test('force goes back to intervals.icu', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    const stub = stubEvents([])

    await sync(token)
    await sync(token, { force: true })
    expect(stub.calls()).toBe(2)
  })

  test('a body-less POST is a plain sync, not a 400', async () => {
    const { token, userId } = await seedUser()
    await configure(userId)
    stubEvents([])

    const res = await makeApp().fetch(
      new Request('http://x/training/sync', { method: 'POST', headers: authHeaders(token) }),
    )
    expect(res.status).toBe(200)
  })
})

describe('isolation', () => {
  test('never writes another user goals', async () => {
    const a = await seedUser()
    const b = await seedUser()
    await configure(a.userId)
    stubEvents([rideOn(today())])

    await sync(a.token)
    expect(await goalsOf(b.userId)).toHaveLength(0)
  })

  test('rejects a request with no Authorization header', async () => {
    const res = await makeApp().fetch(new Request('http://x/training/sync', { method: 'POST' }))
    expect(res.status).toBe(401)
  })
})
