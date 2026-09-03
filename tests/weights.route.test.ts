import { beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { weightsRoute } from '../src/routes/weights.ts'
import { authHeaders, seedUser, truncateAll } from './helpers.ts'

// `weights` is not listed in truncateAll's TRUNCATE, but it FKs to users with
// ON DELETE CASCADE and the statement is CASCADE — same as memories.

function makeApp() {
  return new Hono().route('/weights', weightsRoute)
}

type WeightRow = { id: string; date: string; kg: number; source: string | null }

async function post(token: string, body: unknown) {
  return makeApp().fetch(
    new Request('http://x/weights', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function get(token: string, query = '') {
  return makeApp().fetch(
    new Request(`http://x/weights${query}`, { headers: authHeaders(token) }),
  )
}

beforeEach(async () => {
  await truncateAll()
})

describe('GET /weights', () => {
  test('returns an empty list for a fresh user', async () => {
    const { token } = await seedUser()
    const res = await get(token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('returns rows ascending by date regardless of insertion order', async () => {
    const { token } = await seedUser()
    await post(token, [
      { date: '2026-03-03', kg: 78.1 },
      { date: '2026-03-01', kg: 78.9 },
      { date: '2026-03-02', kg: 78.4 },
    ])

    const rows = (await (await get(token)).json()) as WeightRow[]
    expect(rows.map((r) => r.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
  })

  test('filters by an inclusive [from, to] range', async () => {
    const { token } = await seedUser()
    await post(token, [
      { date: '2026-03-01', kg: 78.9 },
      { date: '2026-03-02', kg: 78.4 },
      { date: '2026-03-03', kg: 78.1 },
    ])

    const rows = (await (
      await get(token, '?from=2026-03-02&to=2026-03-03')
    ).json()) as WeightRow[]
    expect(rows.map((r) => r.date)).toEqual(['2026-03-02', '2026-03-03'])
  })

  test('rejects a range where from is after to', async () => {
    const { token } = await seedUser()
    const res = await get(token, '?from=2026-03-05&to=2026-03-01')
    expect(res.status).toBe(400)
  })

  test('never leaks another user rows', async () => {
    const a = await seedUser()
    const b = await seedUser()
    await post(a.token, { date: '2026-03-01', kg: 78.9 })

    expect(await (await get(b.token)).json()).toEqual([])
    expect(((await (await get(a.token)).json()) as WeightRow[]).length).toBe(1)
  })
})

describe('POST /weights', () => {
  test('accepts a single entry', async () => {
    const { token } = await seedUser()
    const res = await post(token, { date: '2026-03-01', kg: 78.9, source: 'apple-health' })
    expect(res.status).toBe(201)

    const rows = (await res.json()) as WeightRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kg).toBeCloseTo(78.9, 4)
    expect(rows[0]!.source).toBe('apple-health')
  })

  test('accepts a batch in one request', async () => {
    const { token } = await seedUser()
    const res = await post(token, [
      { date: '2026-03-01', kg: 78.9 },
      { date: '2026-03-02', kg: 78.4 },
    ])
    expect(res.status).toBe(201)
    expect((await res.json()) as WeightRow[]).toHaveLength(2)
  })

  // The whole point of the unique index: the user's sync script must be
  // replayable without producing duplicates.
  test('re-posting the same date updates instead of duplicating', async () => {
    const { token } = await seedUser()
    await post(token, { date: '2026-03-01', kg: 78.9, source: 'manual' })
    await post(token, { date: '2026-03-01', kg: 77.5, source: 'scale' })

    const rows = (await (await get(token)).json()) as WeightRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kg).toBeCloseTo(77.5, 4)
    expect(rows[0]!.source).toBe('scale')
  })

  // Postgres raises "ON CONFLICT DO UPDATE cannot affect row a second time"
  // if a single statement touches the same key twice, so the route dedupes.
  test('a batch repeating a date keeps the last value', async () => {
    const { token } = await seedUser()
    const res = await post(token, [
      { date: '2026-03-01', kg: 78.9 },
      { date: '2026-03-01', kg: 77.5 },
    ])
    expect(res.status).toBe(201)

    const rows = (await (await get(token)).json()) as WeightRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kg).toBeCloseTo(77.5, 4)
  })

  test('rejects a malformed date, a non-positive weight, and an empty batch', async () => {
    const { token } = await seedUser()
    expect((await post(token, { date: '03-01-2026', kg: 78 })).status).toBe(400)
    expect((await post(token, { date: '2026-03-01', kg: 0 })).status).toBe(400)
    expect((await post(token, { date: '2026-03-01', kg: -5 })).status).toBe(400)
    expect((await post(token, [])).status).toBe(400)
  })

  // A script accidentally sending pounds would otherwise write silently.
  test('rejects an implausible weight above the 500 kg ceiling', async () => {
    const { token } = await seedUser()
    expect((await post(token, { date: '2026-03-01', kg: 501 })).status).toBe(400)
  })
})

describe('DELETE /weights/:date', () => {
  test('removes the row and reports its id', async () => {
    const { token } = await seedUser()
    await post(token, { date: '2026-03-01', kg: 78.9 })

    const res = await makeApp().fetch(
      new Request('http://x/weights/2026-03-01', {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true })
    expect(await (await get(token)).json()).toEqual([])
  })

  test('404s for a date with no row', async () => {
    const { token } = await seedUser()
    const res = await makeApp().fetch(
      new Request('http://x/weights/2026-03-01', {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(404)
  })

  test('refuses to delete another user row', async () => {
    const a = await seedUser()
    const b = await seedUser()
    await post(a.token, { date: '2026-03-01', kg: 78.9 })

    const res = await makeApp().fetch(
      new Request('http://x/weights/2026-03-01', {
        method: 'DELETE',
        headers: authHeaders(b.token),
      }),
    )
    expect(res.status).toBe(404)
    expect(((await (await get(a.token)).json()) as WeightRow[]).length).toBe(1)
  })
})

describe('auth', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await makeApp().fetch(new Request('http://x/weights'))
    expect(res.status).toBe(401)
  })
})
