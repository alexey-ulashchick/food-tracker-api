// Bearer-token storage and the single fetch wrapper every request goes through.
//
// Mirrors CalTracker/APIClient.swift, with two deliberate differences:
//   * There is no environment switch. The SPA is served from the same origin as
//     the API in production and proxied to it in dev, so every path is relative
//     and CORS never enters the picture.
//   * A 401 clears the token and bounces to /login. iOS had no 401 handling at
//     all — an expired token surfaced as a generic banner, and only in Chat.

const TOKEN_KEY = 'caltracker.token'

/** Format minted by scripts/issue-token.ts: ft_ plus 32 random bytes in hex. */
export const TOKEN_RE = /^ft_[0-9a-f]{64}$/

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    // Private-mode Safari can throw on localStorage access.
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing useful to do; the request will simply come back 401.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'ApiError'
  }
}

/**
 * Authorization plus the client's UTC offset in minutes east of UTC — the same
 * sign convention iOS sends via `TimeZone.current.secondsFromGMT() / 60`, which
 * in JS is `-getTimezoneOffset()`. The backend needs it to decide what "today"
 * means in the user's calendar; without it, goals saved near midnight UTC drift
 * by a day.
 */
export function defaultHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    'X-Client-TZ-Offset': String(-new Date().getTimezoneOffset()),
  }
}

/** Backoff schedule ported from APIClient.backoffNanos. */
const BACKOFF_MS = [200, 500, 1000]

/** Called instead of a hard redirect when a request comes back 401. */
let onUnauthorized: () => void = () => {}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

export type RequestOptions = RequestInit & {
  /** Retries on transport failure only. GETs pass 2; mutations pass none. */
  retries?: number
}

export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const { retries = 0, headers, ...init } = options

  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(path, { ...init, headers: { ...defaultHeaders(), ...headers } })
    } catch (err) {
      // Only transport failures are retried — a rejected fetch means the
      // request never reached the server, so replaying it is safe. An aborted
      // request is the caller's own doing and must propagate.
      if (init.signal?.aborted) throw err
      if (attempt < retries) {
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!)
        continue
      }
      throw err
    }

    if (res.status === 401) {
      setToken('')
      onUnauthorized()
      throw new ApiError(401, await res.text().catch(() => ''))
    }
    if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''))
    return res
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(path, options)
  return (await res.json()) as T
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
