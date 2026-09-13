import type { Context } from 'hono'
import type { AuthEnv } from '../middleware/auth.ts'

// Calendar helpers shared by every route that has to answer "what day is it
// for this caller?".
//
// clientTzOffsetMin existed in three identical private copies — meals,
// day-summary and chat — and src/routes/meals.ts already flagged that as a
// known drift hazard. The training sync would have been the fourth.
//
// Everything here is a fixed minute offset rather than an IANA zone, matching
// what the clients send: iOS reports TimeZone.current.secondsFromGMT() / 60
// and the browser reports -getTimezoneOffset(). That cannot model a future
// DST transition, which is a limitation of the wire contract rather than of
// this module.

/**
 * The caller's UTC offset in minutes east of UTC.
 *
 * Defaults to UTC when the header is absent, so direct curl calls and MCP
 * clients that cannot set headers keep working.
 */
export function clientTzOffsetMin(c: Context<AuthEnv>): number {
  const raw = c.req.header('X-Client-TZ-Offset')
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

/** Today's YYYY-MM-DD in the caller's local calendar. */
export function todayInOffset(offsetMin: number): string {
  return new Date(Date.now() + offsetMin * 60_000).toISOString().slice(0, 10)
}

/**
 * Calendar arithmetic on the ISO string rather than on a Date.
 *
 * Anchoring to midnight UTC and stepping whole days means no local DST
 * transition can make a "+1 day" land on the same date or skip one.
 */
export function addDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + days)
  return t.toISOString().slice(0, 10)
}

/** Every date from `from` to `to`, inclusive on both ends. */
export function dateRange(from: string, to: string): string[] {
  const dates: string[] = []
  let cursor = from
  while (cursor <= to) {
    dates.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return dates
}
