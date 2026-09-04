import { describe, expect, test } from 'bun:test'
import app from '../src/index.ts'

// The SPA and the API share an origin, so their path spaces can collide. This
// file pins the resolution: a browser navigation must reach the app, an API
// client must reach the API, and neither may shadow the other by accident.
//
// No database is touched — an unauthenticated request is enough to tell an API
// response (401 JSON) from the app shell (200 HTML).

const NAVIGATION = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
}
/** What fetch() and URLSession send unless told otherwise. */
const API_CLIENT = { Accept: '*/*' }

async function get(path: string, headers: Record<string, string>) {
  const res = await app.fetch(new Request(`http://localhost${path}`, { headers }))
  return { status: res.status, type: res.headers.get('content-type') ?? '' }
}

const CLIENT_ROUTES = [
  '/',
  '/login',
  '/chat',
  '/history',
  '/you',
  '/you/memories',
  '/you/weight',
  // Unknown paths land on the app, which routes them to Today.
  '/nonsense',
]

const API_ROUTES = ['/meals', '/goals', '/memories', '/chat', '/day-summary', '/weights']

describe('browser navigation', () => {
  test.each(CLIENT_ROUTES)('%s serves the app shell', async (path) => {
    const res = await get(path, NAVIGATION)
    expect(res.status).toBe(200)
    expect(res.type).toContain('text/html')
  })

  test('index.html is never cached, or a deploy pins clients to a stale bundle', async () => {
    const res = await app.fetch(new Request('http://localhost/', { headers: NAVIGATION }))
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })
})

describe('API clients', () => {
  test.each(API_ROUTES)('%s still reaches the API and demands auth', async (path) => {
    const res = await get(path, API_CLIENT)
    expect(res.status).toBe(401)
    expect(res.type).toContain('application/json')
  })

  test('the public health check is unaffected', async () => {
    const res = await get('/health', API_CLIENT)
    expect(res.status).toBe(200)
    expect(res.type).toContain('application/json')
  })
})

// /chat is the one path that is both a screen and an endpoint. Renaming either
// was not an option: the screen's URL should read /chat, and the iOS build in
// the field cannot be changed.
describe('the /chat collision', () => {
  test('a navigation gets the app', async () => {
    const res = await get('/chat', NAVIGATION)
    expect(res.status).toBe(200)
    expect(res.type).toContain('text/html')
  })

  test('the history fetch gets the API, query string and all', async () => {
    const res = await get('/chat?limit=60', API_CLIENT)
    expect(res.status).toBe(401)
    expect(res.type).toContain('application/json')
  })

  test('a request with no Accept header at all is treated as an API call', async () => {
    const res = await app.fetch(new Request('http://localhost/chat'))
    expect(res.status).toBe(401)
  })

  test('only GET is negotiated — POST always reaches the API', async () => {
    for (const headers of [NAVIGATION, API_CLIENT]) {
      const res = await app.fetch(
        new Request('http://localhost/chat', { method: 'POST', headers }),
      )
      expect(res.status).toBe(401)
    }
  })

  test('POST /chat/stream is never intercepted', async () => {
    const res = await app.fetch(
      new Request('http://localhost/chat/stream', { method: 'POST', headers: NAVIGATION }),
    )
    expect(res.status).toBe(401)
  })
})

describe('assets', () => {
  test('hashed assets are cached forever', async () => {
    const files = [...new Bun.Glob('*.js').scanSync('web/dist/assets')]
    expect(files.length).toBeGreaterThan(0)
    const res = await app.fetch(new Request(`http://localhost/assets/${files[0]}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')
  })
})

// A new screen whose path matches an API mount would silently 401 in the
// browser. This is the check that caught /chat in the first place.
describe('no unhandled collisions', () => {
  test('every client route resolves to the app under a navigation', async () => {
    const shadowed: string[] = []
    for (const path of CLIENT_ROUTES) {
      const res = await get(path, NAVIGATION)
      if (!res.type.includes('text/html')) shadowed.push(`${path} → ${res.status} ${res.type}`)
    }
    expect(shadowed).toEqual([])
  })
})
