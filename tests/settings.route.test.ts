import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../src/db/client.ts'
import { userSettings } from '../src/db/schema.ts'
import { settingsRoute } from '../src/routes/settings.ts'
import { DEFAULT_TUNING } from '../shared/goalTuning.ts'
import { authHeaders, seedUser, truncateAll } from './helpers.ts'

// `user_settings` is not named in truncateAll's TRUNCATE, but it FKs to users
// with ON DELETE CASCADE and the statement is CASCADE — same as memories.

function makeApp() {
  return new Hono().route('/settings', settingsRoute)
}

type Wire = {
  userId: string
  goalTuning: typeof DEFAULT_TUNING
  baseCalories: number | null
  proteinG: number | null
  fatG: number | null
  intervalsAthleteId: string | null
  intervalsKeyHint: string | null
  intervalsSyncedAt: string | null
  updatedAt: string
}

async function get(token: string) {
  return makeApp().fetch(new Request('http://x/settings', { headers: authHeaders(token) }))
}

async function patch(token: string, body: unknown) {
  return makeApp().fetch(
    new Request('http://x/settings', {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(async () => {
  await truncateAll()
})

describe('GET /settings', () => {
  test('returns an all-null row before anything is configured', async () => {
    const { token, userId } = await seedUser()

    const res = await get(token)
    expect(res.status).toBe(200)

    const body = (await res.json()) as Wire
    expect(body).toEqual({
      userId,
      baseCalories: null,
      proteinG: null,
      fatG: null,
      intervalsAthleteId: null,
      intervalsKeyHint: null,
      intervalsSyncedAt: null,
      // Complete, not null: the tuning is the one field with defaults.
      goalTuning: DEFAULT_TUNING,
      updatedAt: body.updatedAt,
    })
  })

  test('creates the row once, not once per read', async () => {
    const { token, userId } = await seedUser()

    await get(token)
    await get(token)
    await get(token)

    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(rows).toHaveLength(1)
  })

  test('never leaks another user rows', async () => {
    const a = await seedUser()
    const b = await seedUser()
    await patch(a.token, { baseCalories: 1450 })

    const body = (await (await get(b.token)).json()) as Wire
    expect(body.userId).toBe(b.userId)
    expect(body.baseCalories).toBeNull()
  })
})

describe('the intervals.icu key', () => {
  const KEY = 'abcdefghijklmnop1234'

  test('goes in but does not come back out', async () => {
    const { token } = await seedUser()
    await patch(token, { intervalsApiKey: KEY })

    const res = await get(token)
    const raw = await res.text()

    // Asserted on the raw body, not the parsed object: a future field that
    // carries the key under another name has to fail this too.
    expect(raw).not.toContain(KEY)
    expect(JSON.parse(raw).intervalsKeyHint).toBe('1234')
  })

  test('is actually persisted, hint notwithstanding', async () => {
    const { token, userId } = await seedUser()
    await patch(token, { intervalsApiKey: KEY })

    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(row?.intervalsApiKey).toBe(KEY)
  })

  test('is cleared by an explicit null', async () => {
    const { token } = await seedUser()
    await patch(token, { intervalsApiKey: KEY })

    const body = (await (await patch(token, { intervalsApiKey: null })).json()) as Wire
    expect(body.intervalsKeyHint).toBeNull()
  })

  test('survives a patch that does not mention it', async () => {
    const { token } = await seedUser()
    await patch(token, { intervalsApiKey: KEY })

    const body = (await (await patch(token, { proteinG: 140 })).json()) as Wire
    expect(body.intervalsKeyHint).toBe('1234')
    expect(body.proteinG).toBe(140)
  })
})

describe('PATCH /settings', () => {
  test('stores the base and the fixed macros', async () => {
    const { token } = await seedUser()

    const body = (await (
      await patch(token, { baseCalories: 1450, proteinG: 140, fatG: 60 })
    ).json()) as Wire

    expect(body.baseCalories).toBe(1450)
    expect(body.proteinG).toBe(140)
    expect(body.fatG).toBe(60)
  })

  test('normalises a bare athlete number to the i-prefixed form', async () => {
    const { token } = await seedUser()

    const bare = (await (await patch(token, { intervalsAthleteId: '123456' })).json()) as Wire
    expect(bare.intervalsAthleteId).toBe('i123456')

    const prefixed = (await (await patch(token, { intervalsAthleteId: 'i987' })).json()) as Wire
    expect(prefixed.intervalsAthleteId).toBe('i987')
  })

  test('rejects values that are not plausible', async () => {
    const { token } = await seedUser()

    // A kJ figure pasted into the kcal field.
    expect((await patch(token, { baseCalories: 60000 })).status).toBe(400)
    expect((await patch(token, { baseCalories: 0 })).status).toBe(400)
    expect((await patch(token, { proteinG: -1 })).status).toBe(400)
    expect((await patch(token, { intervalsAthleteId: 'not-an-id' })).status).toBe(400)
    expect((await patch(token, { intervalsApiKey: 'short' })).status).toBe(400)
  })

  test('rejects an unknown field rather than silently ignoring it', async () => {
    const { token } = await seedUser()
    // The failure this prevents: a typo saves nothing and reports success.
    expect((await patch(token, { proteinGrams: 140 })).status).toBe(400)
  })

  test('rejects an empty patch', async () => {
    const { token } = await seedUser()
    expect((await patch(token, {})).status).toBe(400)
  })

  test('moves updatedAt', async () => {
    const { token } = await seedUser()
    const before = (await (await get(token)).json()) as Wire

    await Bun.sleep(5)
    const after = (await (await patch(token, { fatG: 60 })).json()) as Wire

    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
  })
})

describe('the goal tuning', () => {
  test('comes back complete before anything is set', async () => {
    // The client edits a whole tuning; it should never have to reason about
    // which dials happen to be stored.
    const { token } = await seedUser()
    const body = (await (await get(token)).json()) as Wire
    expect(body.goalTuning).toEqual(DEFAULT_TUNING)
  })

  test('stores only what differs from the defaults', async () => {
    // So a dial added later arrives at its default for everyone instead of
    // needing a backfill.
    const { token, userId } = await seedUser()
    await patch(token, { goalTuning: { ...DEFAULT_TUNING, vo2max: 1 } })

    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(row?.goalTuning).toEqual({ vo2max: 1 })
  })

  test('reads back merged over the defaults', async () => {
    const { token } = await seedUser()
    const body = (await (
      await patch(token, { goalTuning: { ...DEFAULT_TUNING, vo2max: 1 } })
    ).json()) as Wire

    expect(body.goalTuning.vo2max).toBe(1)
    expect(body.goalTuning.z2Short).toBe(DEFAULT_TUNING.z2Short)
  })

  test('a tuning identical to the defaults stores nothing at all', async () => {
    const { token, userId } = await seedUser()
    await patch(token, { goalTuning: DEFAULT_TUNING })

    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(row?.goalTuning).toBeNull()
  })

  test('null resets every dial', async () => {
    const { token, userId } = await seedUser()
    await patch(token, { goalTuning: { ...DEFAULT_TUNING, vo2max: 1, strengthKcal: 400 } })

    const body = (await (await patch(token, { goalTuning: null })).json()) as Wire
    expect(body.goalTuning).toEqual(DEFAULT_TUNING)

    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId))
    expect(row?.goalTuning).toBeNull()
  })

  test('survives a patch that does not mention it', async () => {
    const { token } = await seedUser()
    await patch(token, { goalTuning: { ...DEFAULT_TUNING, vo2max: 1 } })

    const body = (await (await patch(token, { proteinG: 140 })).json()) as Wire
    expect(body.goalTuning.vo2max).toBe(1)
  })

  test('rejects a value outside the bounds the form shows', async () => {
    const { token } = await seedUser()
    expect((await patch(token, { goalTuning: { vo2max: 50 } })).status).toBe(400)
    expect((await patch(token, { goalTuning: { strengthKcal: -1 } })).status).toBe(400)
    expect((await patch(token, { goalTuning: { definingBlockSeconds: 1 } })).status).toBe(400)
  })

  test('rejects inverted band edges rather than storing a dead band', async () => {
    const { token } = await seedUser()
    const res = await patch(token, {
      goalTuning: { z2ShortMaxMinutes: 200, z2LongMinMinutes: 100 },
    })
    expect(res.status).toBe(400)
  })

  test('rejects a dial that does not exist', async () => {
    const { token } = await seedUser()
    expect((await patch(token, { goalTuning: { z2Shorter: 0.5 } })).status).toBe(400)
  })
})

describe('auth', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await makeApp().fetch(new Request('http://x/settings'))
    expect(res.status).toBe(401)
  })
})
