import { beforeEach, describe, expect, test } from 'bun:test'
import app from '../src/index.ts'
import { db } from '../src/db/client.ts'
import { chatMessages } from '../src/db/schema.ts'
import { eq } from 'drizzle-orm'
import { authHeaders, llmResponse, seedMeal, seedUser, truncateAll } from './helpers.ts'
import { messagesCreate } from './setup.ts'

// Compatibility net for the cutover window, when the iOS build in the field and
// the web client both talk to this server.
//
// Every request below is shaped the way CalTracker/APIClient.swift shapes it:
//   * Authorization plus X-Client-TZ-Offset, and NO Accept header — URLSession
//     does not add one, which is what keeps the SPA's /chat navigation guard
//     from stealing the history endpoint.
//   * `Accept: text/event-stream` on /chat/recommend only.
//   * multipart POST /chat carrying `content` and `image`, never `thumb`.
//
// It is deliberately about the wire contract, not about features: if one of
// these breaks, a shipped app that cannot be updated stops working.

/** iOS default headers: no Accept, no Content-Type on multipart. */
function iosHeaders(token: string, extra: Record<string, string> = {}) {
  return { ...authHeaders(token), 'X-Client-TZ-Offset': '180', ...extra }
}

const IOS_ENDPOINTS = [
  '/chat?limit=60',
  '/goals',
  '/goals?date=2026-09-04',
  '/meals?dateFrom=2026-09-04&dateTo=2026-09-04&limit=500',
  '/memories',
  '/day-summary?from=2026-09-04&to=2026-09-04',
]

beforeEach(async () => {
  await truncateAll()
  messagesCreate.mockReset()
})

describe('iOS reads', () => {
  test.each(IOS_ENDPOINTS)('%s returns JSON, not the app shell', async (path) => {
    const { token } = await seedUser()
    const res = await app.fetch(new Request(`http://x${path}`, { headers: iosHeaders(token) }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  test('GET /meals still carries localDate on every row', async () => {
    const { userId, token } = await seedUser()
    await seedMeal(userId, {
      foodName: 'Овсянка',
      timestamp: new Date('2026-09-04T06:00:00Z'),
      tzOffsetMin: 180,
    })

    const res = await app.fetch(
      new Request('http://x/meals?dateFrom=2026-09-04&dateTo=2026-09-04&limit=500', {
        headers: iosHeaders(token),
      }),
    )
    const rows = (await res.json()) as Array<{ localDate: string; foodName: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.localDate).toBe('2026-09-04')
  })

  test('/day-summary keeps its shape — the fields the Swift DTO decodes', async () => {
    const { token } = await seedUser()
    const res = await app.fetch(
      new Request('http://x/day-summary?from=2026-09-04&to=2026-09-04', {
        headers: iosHeaders(token),
      }),
    )
    const rows = (await res.json()) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    // ServerDaySummary in APIClient.swift decodes exactly these.
    for (const key of ['date', 'color', 'title', 'reason', 'eaten', 'goal']) {
      expect(Object.keys(rows[0]!)).toContain(key)
    }
  })
})

describe('iOS writes', () => {
  // The iOS multipart body has no `thumb` part; the field was added for the web
  // client and must stay optional.
  test('POST /chat accepts content plus image with no thumb', async () => {
    const { userId, token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'Вижу' }], stop_reason: 'end_turn' }),
    )

    const form = new FormData()
    form.set('content', 'что это?')
    form.set('image', new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }))

    const res = await app.fetch(
      new Request('http://x/chat', { method: 'POST', headers: iosHeaders(token), body: form }),
    )
    expect(res.status).toBe(201)

    // The envelope Swift's ChatPostResponse decodes.
    const body = (await res.json()) as { user: unknown; ai: unknown[] }
    expect(body.user).toBeDefined()
    expect(Array.isArray(body.ai)).toBe(true)

    const rows = await db.select().from(chatMessages).where(eq(chatMessages.userId, userId))
    const userRow = rows.find((r) => r.role === 'user')
    expect(userRow?.meta).toMatchObject({ hadImage: true, mediaType: 'image/jpeg' })
    // No thumb was sent, so none is stored — iOS never reads the field anyway.
    expect((userRow?.meta as Record<string, unknown>).thumb).toBeUndefined()
  })

  test('POST /chat still accepts a JSON body for text-only turns', async () => {
    const { token } = await seedUser()
    messagesCreate.mockResolvedValueOnce(
      llmResponse({ content: [{ type: 'text', text: 'ок' }], stop_reason: 'end_turn' }),
    )

    const res = await app.fetch(
      new Request('http://x/chat', {
        method: 'POST',
        headers: iosHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ content: 'привет' }),
      }),
    )
    expect(res.status).toBe(201)
  })

  // POST /meals grew 'Snack'; the three the iOS picker offers must still pass.
  test.each(['Breakfast', 'Lunch', 'Dinner'])('POST /meals still accepts %s', async (meal) => {
    const { token } = await seedUser()
    const res = await app.fetch(
      new Request('http://x/meals', {
        method: 'POST',
        headers: iosHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ meal, foodName: 'x', calories: 100 }),
      }),
    )
    expect(res.status).toBe(201)
  })

  test('memories CRUD is untouched', async () => {
    const { token } = await seedUser()
    const created = await app.fetch(
      new Request('http://x/memories', {
        method: 'POST',
        headers: iosHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ content: 'Аллергия: лактоза' }),
      }),
    )
    expect(created.status).toBe(201)
    const row = (await created.json()) as { id: string }

    const patched = await app.fetch(
      new Request(`http://x/memories/${row.id}`, {
        method: 'PATCH',
        headers: iosHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ content: 'Аллергия: лактоза и орехи' }),
      }),
    )
    expect(patched.status).toBe(200)

    const deleted = await app.fetch(
      new Request(`http://x/memories/${row.id}`, {
        method: 'DELETE',
        headers: iosHeaders(token),
      }),
    )
    expect(deleted.status).toBe(200)
    expect((await deleted.json()) as { ok: boolean }).toMatchObject({ ok: true })
  })
})

// This is the single riskiest change for iOS: a guard was added in front of the
// API to give browser navigations of /chat the app instead of the endpoint.
describe('the /chat guard does not touch iOS', () => {
  test('GET /chat with iOS headers reaches the API', async () => {
    const { token } = await seedUser()
    const res = await app.fetch(new Request('http://x/chat?limit=60', { headers: iosHeaders(token) }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  test('the wildcard Accept URLSession may send is still an API call', async () => {
    const { token } = await seedUser()
    const res = await app.fetch(
      new Request('http://x/chat?limit=60', { headers: iosHeaders(token, { Accept: '*/*' }) }),
    )
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  test('POST /chat/recommend with an SSE Accept opens a stream', async () => {
    const { token } = await seedUser()
    const res = await app.fetch(
      new Request('http://x/chat/recommend', {
        method: 'POST',
        headers: iosHeaders(token, { Accept: 'text/event-stream' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })
})

// Day verdicts are now Russian. That is a visible change in the shipped iOS
// build, not a break — it decodes whatever strings arrive.
describe('day verdicts', () => {
  test('title and reason are non-empty strings the Swift DTO can decode', async () => {
    const { token } = await seedUser()
    const res = await app.fetch(
      new Request('http://x/day-summary?from=2026-09-04&to=2026-09-04', {
        headers: iosHeaders(token),
      }),
    )
    const rows = (await res.json()) as Array<{ title: string; reason: string; color: string }>
    expect(typeof rows[0]!.title).toBe('string')
    expect(rows[0]!.title.length).toBeGreaterThan(0)
    expect(rows[0]!.reason.length).toBeGreaterThan(0)
    // The colour vocabulary is what iOS switches on, and it has not changed.
    expect(['gray', 'blue', 'green', 'light_green', 'yellow', 'orange', 'red']).toContain(
      rows[0]!.color,
    )
  })
})
