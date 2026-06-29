import { beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mealsRoute } from '../src/routes/meals.ts'
import { authHeaders, seedMeal, seedUser, truncateAll } from './helpers.ts'

function makeApp() {
  return new Hono().route('/meals', mealsRoute)
}

beforeEach(async () => {
  await truncateAll()
})

describe('GET /meals', () => {
  test('returns each row with a localDate field', async () => {
    const { userId, token } = await seedUser()
    await seedMeal(userId, {
      foodName: 'Yogurt',
      timestamp: new Date('2026-06-29T06:00:00Z'),
      tzOffsetMin: 180, // Moscow — June 29 in MSK
    })

    const res = await makeApp().fetch(
      new Request('http://x/meals?dateFrom=2026-06-29&dateTo=2026-06-29', {
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ foodName: string; localDate: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.localDate).toBe('2026-06-29')
  })

  test('buckets by meal own TZ, not by request X-Client-TZ-Offset', async () => {
    const { userId, token } = await seedUser()
    // Moscow breakfast at UTC 06:00 June 29 → June 29 in MSK (+180).
    await seedMeal(userId, {
      foodName: 'MSK breakfast',
      timestamp: new Date('2026-06-29T06:00:00Z'),
      tzOffsetMin: 180,
    })
    // LA dinner at UTC 01:00 June 29 → June 28 in PT (−480).
    await seedMeal(userId, {
      foodName: 'LA dinner',
      timestamp: new Date('2026-06-29T01:00:00Z'),
      tzOffsetMin: -480,
    })

    // Client in LA (−420 with DST or −480 standard) asks for June 29:
    const res = await makeApp().fetch(
      new Request('http://x/meals?dateFrom=2026-06-29&dateTo=2026-06-29', {
        headers: { ...authHeaders(token), 'X-Client-TZ-Offset': '-420' },
      }),
    )
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ foodName: string; localDate: string }>
    // Only the Moscow breakfast belongs to "June 29" — it's June 29 in its
    // OWN MSK. The LA meal is June 28 in its own PT and must NOT appear,
    // even though the caller is currently in PT.
    expect(rows.map((r) => r.foodName)).toEqual(['MSK breakfast'])
    expect(rows[0]!.localDate).toBe('2026-06-29')
  })

  test('LA→Moscow eastbound: each meal stays under its own local date', async () => {
    const { userId, token } = await seedUser()
    // LA dinner on what's still June 28 PT.
    await seedMeal(userId, {
      foodName: 'LA dinner',
      timestamp: new Date('2026-06-29T01:00:00Z'),
      tzOffsetMin: -480,
    })
    // Moscow evening meal on June 29 MSK.
    await seedMeal(userId, {
      foodName: 'Moscow evening',
      timestamp: new Date('2026-06-29T18:00:00Z'),
      tzOffsetMin: 180,
    })

    const june28 = (await (await makeApp().fetch(
      new Request('http://x/meals?dateFrom=2026-06-28&dateTo=2026-06-28', {
        headers: authHeaders(token),
      }),
    )).json()) as Array<{ foodName: string }>
    expect(june28.map((r) => r.foodName)).toEqual(['LA dinner'])

    const june29 = (await (await makeApp().fetch(
      new Request('http://x/meals?dateFrom=2026-06-29&dateTo=2026-06-29', {
        headers: authHeaders(token),
      }),
    )).json()) as Array<{ foodName: string }>
    expect(june29.map((r) => r.foodName)).toEqual(['Moscow evening'])
  })

  test('range covers multiple days and labels each row with its own date', async () => {
    const { userId, token } = await seedUser()
    await seedMeal(userId, {
      foodName: 'Day A',
      timestamp: new Date('2026-06-27T18:00:00Z'),
      tzOffsetMin: 180, // June 27 MSK
    })
    await seedMeal(userId, {
      foodName: 'Day B',
      timestamp: new Date('2026-06-29T01:00:00Z'),
      tzOffsetMin: -480, // June 28 PT
    })
    await seedMeal(userId, {
      foodName: 'Day C',
      timestamp: new Date('2026-06-29T18:00:00Z'),
      tzOffsetMin: 180, // June 29 MSK
    })

    const res = await makeApp().fetch(
      new Request('http://x/meals?dateFrom=2026-06-27&dateTo=2026-06-29', {
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ foodName: string; localDate: string }>
    const byName = new Map(rows.map((r) => [r.foodName, r.localDate]))
    expect(byName.get('Day A')).toBe('2026-06-27')
    expect(byName.get('Day B')).toBe('2026-06-28')
    expect(byName.get('Day C')).toBe('2026-06-29')
  })

  test('rejects dateFrom without dateTo', async () => {
    const { token } = await seedUser()
    const res = await makeApp().fetch(
      new Request('http://x/meals?dateFrom=2026-06-29', {
        headers: authHeaders(token),
      }),
    )
    expect(res.status).toBe(400)
  })

  test('without date params returns newest first across all history', async () => {
    const { userId, token } = await seedUser()
    await seedMeal(userId, {
      foodName: 'Old',
      timestamp: new Date('2026-06-01T12:00:00Z'),
      tzOffsetMin: 0,
    })
    await seedMeal(userId, {
      foodName: 'New',
      timestamp: new Date('2026-06-29T12:00:00Z'),
      tzOffsetMin: 0,
    })

    const res = await makeApp().fetch(
      new Request('http://x/meals', { headers: authHeaders(token) }),
    )
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ foodName: string; localDate: string }>
    expect(rows[0]!.foodName).toBe('New')
    // Even the fallback path decorates rows with localDate.
    expect(rows[0]!.localDate).toBe('2026-06-29')
  })
})
