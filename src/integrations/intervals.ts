import type { PlannedSession, PlannedStep } from '../lib/trainingLoad.ts'

/**
 * The one outbound integration in this codebase.
 *
 * Deliberately imports neither src/env.ts nor the database: credentials
 * arrive as arguments, so scripts/intervals-probe.ts can run the normaliser
 * without a Postgres connection or an Anthropic key.
 *
 * ── A standing caveat about field names ────────────────────────────────────
 * intervals.icu is not reachable from the machine this was written on, so the
 * exact spelling of every field below was taken from the documented shape and
 * is confirmed by running scripts/intervals-probe.ts against a real account.
 * Everything here is therefore written to tolerate an alias rather than to
 * assume one, and anything it cannot read degrades to `unknown` — which the
 * goals screen shows — rather than to a plausible wrong number.
 */

// ── Wire shape ─────────────────────────────────────────────────────────────

export type RawEvent = Record<string, unknown>

type RawStep = {
  duration?: unknown
  reps?: unknown
  steps?: unknown
  power?: unknown
}

/**
 * Activity types that count as a ride, so their planned kilojoules are scaled.
 *
 * If the probe's `distinct values` census shows a type you ride that is not
 * here, this set is the only place to add it.
 */
export const RIDE_TYPES = new Set([
  'Ride',
  'VirtualRide',
  'GravelRide',
  'MountainBikeRide',
  'EBikeRide',
  'Handcycle',
  'Velomobile',
])

/**
 * Activity types that earn the flat strength bonus.
 *
 * `Workout` is deliberately absent: intervals.icu uses it as a catch-all for
 * anything without its own type, so counting it would hand 250 kcal to yoga
 * and to a physio session alike. Add it here if the probe shows your gym
 * sessions actually carry it.
 */
export const STRENGTH_TYPES = new Set(['WeightTraining', 'Crossfit'])

/**
 * Calendar entries that represent training. Everything else — notes, holidays,
 * illness markers, FTP changes — is carried through as `other` so it cannot
 * add calories.
 */
const TRAINING_CATEGORIES = new Set(['WORKOUT', 'RACE_A', 'RACE_B', 'RACE_C'])

/** Kilojoules, under whichever name this account's events use. Joules. */
const JOULE_KEYS = ['joules', 'icu_joules', 'planned_joules'] as const
/** Planned moving time, seconds. */
const SECONDS_KEYS = ['moving_time', 'duration', 'icu_moving_time'] as const

/** One session is never this large; past it, the units are not what we think. */
const IMPLAUSIBLE_KJ = 20_000

// ── Normalisation ──────────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function firstNumber(raw: RawEvent, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = num(raw[k])
    if (v !== undefined) return v
  }
  return undefined
}

/**
 * A step's target as a fraction of FTP.
 *
 * Returns undefined when there is nothing to read — a free-ride or cadence
 * step carries no power target, and guessing one would be worse than leaving
 * it out of the classification entirely.
 */
export function stepIntensity(power: unknown, ftp: number | undefined): number | undefined {
  if (!power || typeof power !== 'object') return undefined
  const p = power as { units?: unknown; value?: unknown; start?: unknown; end?: unknown }

  const start = num(p.start)
  const end = num(p.end)
  // A ramp is judged by its midpoint.
  const value =
    num(p.value) ?? (start !== undefined && end !== undefined ? (start + end) / 2 : (start ?? end))
  if (value === undefined) return undefined

  const units = typeof p.units === 'string' ? p.units.toLowerCase() : ''
  if (units.includes('%')) return value / 100
  if (units === 'w' || units === 'watts') return ftp && ftp > 0 ? value / ftp : undefined

  // No units given. A percentage is written as 65 and a fraction as 0.65;
  // nothing sane sits between, so the magnitude disambiguates.
  return value > 3 ? value / 100 : value
}

/** Guards against a pathologically nested workout_doc. */
const MAX_STEP_DEPTH = 8

function flattenSteps(
  steps: unknown,
  ftp: number | undefined,
  out: PlannedStep[],
  depth = 0,
): void {
  if (!Array.isArray(steps) || depth > MAX_STEP_DEPTH) return

  for (const entry of steps) {
    if (!entry || typeof entry !== 'object') continue
    const step = entry as RawStep

    // A repeat: `reps` copies of the nested steps. Expanded rather than
    // multiplied so the time-in-band sum needs no special case.
    if (Array.isArray(step.steps) && step.steps.length > 0) {
      const reps = Math.max(1, Math.round(num(step.reps) ?? 1))
      for (let i = 0; i < reps; i++) flattenSteps(step.steps, ftp, out, depth + 1)
      continue
    }

    const seconds = num(step.duration)
    const intensity = stepIntensity(step.power, ftp)
    // Distance-based steps have no duration and cannot be weighed by time.
    if (seconds !== undefined && seconds > 0 && intensity !== undefined) {
      out.push({ seconds, intensity })
    }
  }
}

function sessionKind(raw: RawEvent): PlannedSession['kind'] {
  const category = typeof raw.category === 'string' ? raw.category : 'WORKOUT'
  if (!TRAINING_CATEGORIES.has(category)) return 'other'

  const type = typeof raw.type === 'string' ? raw.type : ''
  if (RIDE_TYPES.has(type)) return 'ride'
  if (STRENGTH_TYPES.has(type)) return 'strength'
  return 'other'
}

/**
 * One event → one session, or null when it carries no usable date.
 *
 * `start_date_local` is already in the athlete's own calendar, so the day is a
 * string slice and no offset arithmetic is involved.
 */
export function normaliseEvent(raw: RawEvent): PlannedSession | null {
  const stamp = raw.start_date_local ?? raw.start_date
  if (typeof stamp !== 'string' || stamp.length < 10) return null
  const date = stamp.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  const doc = (raw.workout_doc ?? null) as Record<string, unknown> | null
  const ftp = doc ? num(doc.ftp) : undefined

  const steps: PlannedStep[] = []
  if (doc) flattenSteps(doc.steps, ftp, steps)

  const joules = firstNumber(raw, JOULE_KEYS)
  const kj = joules !== undefined ? joules / 1000 : undefined
  if (kj !== undefined && kj > IMPLAUSIBLE_KJ) {
    // Loud rather than silently 1000× wrong. The goals screen will show the
    // number, so it is better to see it flagged than to wonder at it.
    console.warn(`[intervals] implausible planned work: ${Math.round(kj)} kJ for "${raw.name}"`)
  }

  const seconds = firstNumber(raw, SECONDS_KEYS) ?? (doc ? num(doc.duration) : undefined)

  return {
    date,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'Тренировка',
    kind: sessionKind(raw),
    ...(kj !== undefined ? { kj } : {}),
    minutes: seconds !== undefined ? seconds / 60 : 0,
    steps,
  }
}

export function normaliseEvents(raw: readonly RawEvent[]): PlannedSession[] {
  return raw.map(normaliseEvent).filter((s): s is PlannedSession => s !== null)
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export type IntervalsCredentials = { athleteId: string; apiKey: string }

export class IntervalsError extends Error {
  constructor(
    /** The upstream HTTP status, or 0 when no response arrived. Callers do
     *  NOT forward it: answering a browser with 401 would make the API client
     *  throw away its own bearer token over someone else's rejected key. */
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'IntervalsError'
  }
}

const REQUEST_TIMEOUT_MS = 10_000

/**
 * Raw events for a date window.
 *
 * Basic auth with the literal username "API_KEY" and the key as the password,
 * which is what intervals.icu documents. The key never appears in a thrown
 * message or a log line.
 */
export async function fetchRawEvents(
  creds: IntervalsCredentials,
  from: string,
  to: string,
): Promise<RawEvent[]> {
  const url = `https://intervals.icu/api/v1/athlete/${creds.athleteId}/events?oldest=${from}&newest=${to}`

  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Basic ${btoa(`API_KEY:${creds.apiKey}`)}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new IntervalsError(0, `intervals.icu unreachable: ${(err as Error).message}`)
  }

  if (!res.ok) {
    throw new IntervalsError(
      res.status,
      res.status === 401 || res.status === 403
        ? 'intervals.icu rejected the credentials — check the API key and the athlete id'
        : `intervals.icu returned ${res.status}`,
    )
  }

  const body: unknown = await res.json()
  if (!Array.isArray(body)) {
    throw new IntervalsError(200, 'intervals.icu returned something that is not a list of events')
  }
  return body as RawEvent[]
}

// ── Cache ──────────────────────────────────────────────────────────────────

/**
 * Five minutes, per athlete and window.
 *
 * Not about load: the web client refetches on window focus, so without this
 * every tab switch is a round trip to intervals.icu. The Fly machine scales to
 * zero, so the cache lives until the app goes idle, which is exactly as long
 * as it is useful.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000

const cache = new Map<string, { at: number; events: RawEvent[] }>()

/** Empties the cache. Used by the force path and by tests. */
export function clearIntervalsCache(): void {
  cache.clear()
}

export async function fetchPlannedSessions(
  creds: IntervalsCredentials,
  from: string,
  to: string,
  opts: { force?: boolean } = {},
): Promise<PlannedSession[]> {
  const key = `${creds.athleteId}:${from}:${to}`
  if (opts.force) cache.delete(key)

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return normaliseEvents(hit.events)

  const events = await fetchRawEvents(creds, from, to)
  cache.set(key, { at: Date.now(), events })
  return normaliseEvents(events)
}
