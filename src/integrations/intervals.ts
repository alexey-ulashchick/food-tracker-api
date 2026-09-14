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
 * A step's power target, as both a fraction of FTP and absolute watts.
 *
 * Both, because they answer different questions: the fraction classifies the
 * step, and the watts let planned work be summed when intervals.icu did not
 * send a `joules` figure. Either can be missing — a free-ride step names no
 * target at all, and a watt target cannot be turned into a fraction without
 * an FTP to divide by.
 */
export function stepTarget(
  power: unknown,
  ftp: number | undefined,
): { intensity?: number; watts?: number } {
  if (!power || typeof power !== 'object') return {}
  const p = power as { units?: unknown; value?: unknown; start?: unknown; end?: unknown }

  const start = num(p.start)
  const end = num(p.end)
  // A ramp is judged by its midpoint — which is also its mean work rate, so
  // the same number serves both purposes.
  const value =
    num(p.value) ?? (start !== undefined && end !== undefined ? (start + end) / 2 : (start ?? end))
  if (value === undefined) return {}

  const units = typeof p.units === 'string' ? p.units.toLowerCase() : ''

  if (units === 'w' || units === 'watts') {
    return { watts: value, ...(ftp && ftp > 0 ? { intensity: value / ftp } : {}) }
  }

  const intensity = units.includes('%')
    ? value / 100
    : // No units given. A percentage is written as 65 and a fraction as 0.65;
      // nothing sane sits between, so the magnitude disambiguates.
      value > 3
      ? value / 100
      : value
  return { intensity, ...(ftp && ftp > 0 ? { watts: intensity * ftp } : {}) }
}

/**
 * The FTP that watt targets are scaled against, most specific source first.
 *
 * 1. The plan's own `ftp`, when it carries one — that is the figure the watts
 *    in this particular workout were authored against.
 * 2. The athlete's cycling FTP from intervals.icu (see fetchAthleteFtp).
 * 3. Recovered from the event: intensity factor is NP / FTP, and intervals.icu
 *    sends both, so the number falls out of the response with no extra
 *    request. Verified against a real account — it returned 250 W exactly.
 *
 * Nothing here is a stored setting. A number typed into a settings form goes
 * stale the moment FTP changes in intervals.icu, and the plans' watt targets
 * move with the real one, so the two would silently disagree.
 */
export function resolveFtp(
  raw: RawEvent,
  doc: Record<string, unknown> | null,
  athleteFtp?: number,
): number | undefined {
  const stated = doc ? num(doc.ftp) : undefined
  if (stated && stated > 0) return stated

  if (athleteFtp && athleteFtp > 0) return athleteFtp

  const np = doc ? num(doc.normalized_power) : undefined
  // Percent, not a fraction: 81.157 means an IF of 0.81157.
  const intensity = num(raw.icu_intensity)
  if (np && np > 0 && intensity && intensity > 0) return np / (intensity / 100)

  return undefined
}

/** Guards against a pathologically nested workout_doc. */
const MAX_STEP_DEPTH = 8

type FlatStep = { seconds: number; intensity?: number; watts?: number }

function flattenSteps(steps: unknown, ftp: number | undefined, out: FlatStep[], depth = 0): void {
  if (!Array.isArray(steps) || depth > MAX_STEP_DEPTH) return

  for (const entry of steps) {
    if (!entry || typeof entry !== 'object') continue
    const step = entry as RawStep

    // A repeat: `reps` copies of the nested steps. Expanded rather than
    // multiplied so the time-in-band sum needs no special case. It carries its
    // own `duration` as well, which must not be counted on top of the copies.
    if (Array.isArray(step.steps) && step.steps.length > 0) {
      const reps = Math.max(1, Math.round(num(step.reps) ?? 1))
      for (let i = 0; i < reps; i++) flattenSteps(step.steps, ftp, out, depth + 1)
      continue
    }

    const seconds = num(step.duration)
    // Distance-based steps have no duration and cannot be weighed by time.
    if (seconds === undefined || seconds <= 0) continue
    out.push({ seconds, ...stepTarget(step.power, ftp) })
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
export function normaliseEvent(raw: RawEvent, athleteFtp?: number): PlannedSession | null {
  const stamp = raw.start_date_local ?? raw.start_date
  if (typeof stamp !== 'string' || stamp.length < 10) return null
  const date = stamp.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  const doc = (raw.workout_doc ?? null) as Record<string, unknown> | null
  const ftp = resolveFtp(raw, doc, athleteFtp)

  const flat: FlatStep[] = []
  if (doc) flattenSteps(doc.steps, ftp, flat)

  const steps: PlannedStep[] = flat
    .filter((s): s is FlatStep & { intensity: number } => s.intensity !== undefined)
    .map((s) => ({ seconds: s.seconds, intensity: s.intensity }))

  // Steps that named watts we could not scale, because no FTP was recoverable.
  // Counted rather than dropped silently: with none of them scaled the ride is
  // unclassifiable, and the screen should say why rather than shrug.
  const unscaledSteps = flat.filter(
    (s) => s.intensity === undefined && s.watts !== undefined,
  ).length

  const joules = firstNumber(raw, JOULE_KEYS)
  // Not every planned event carries `joules`, but a structured one carries
  // everything needed to work it out: watts × seconds. Verified against a real
  // response — the sum reproduced intervals.icu's own figure to the joule.
  const stepJoules = flat.reduce((sum, s) => sum + (s.watts ?? 0) * s.seconds, 0)
  const kj = joules !== undefined ? joules / 1000 : stepJoules > 0 ? stepJoules / 1000 : undefined
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
    unscaledSteps,
  }
}

export function normaliseEvents(raw: readonly RawEvent[], athleteFtp?: number): PlannedSession[] {
  return raw
    .map((e) => normaliseEvent(e, athleteFtp))
    .filter((s): s is PlannedSession => s !== null)
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

/**
 * The athlete's cycling FTP, or undefined if it cannot be read.
 *
 * Never throws: a sync must not fail because this one extra request did.
 * resolveFtp still has the event-derived fallback underneath it, which is
 * verified working against a real account, so losing this only costs
 * robustness on events that carry no normalised power.
 *
 * The response shape is tolerated rather than assumed — an array of per-sport
 * settings, a single object, or a bare `{ ftp }` all work — because guessing
 * `workout_doc.ftp` is precisely what made every ride unclassifiable the first
 * time round. `bun run intervals:probe --explain` prints what actually came
 * back.
 */
export async function fetchAthleteFtp(creds: IntervalsCredentials): Promise<number | undefined> {
  const url = `https://intervals.icu/api/v1/athlete/${creds.athleteId}/sport-settings`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${btoa(`API_KEY:${creds.apiKey}`)}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    return pickCyclingFtp(await res.json())
  } catch {
    return undefined
  }
}

/** Sport types whose FTP is the one that scales a ride's watt targets. */
const FTP_SPORTS = new Set([...RIDE_TYPES])

/** Extracts the cycling FTP from whatever shape sport-settings arrives in. */
export function pickCyclingFtp(body: unknown): number | undefined {
  const entries = Array.isArray(body) ? body : [body]

  const ftpOf = (e: unknown): number | undefined => {
    if (!e || typeof e !== 'object') return undefined
    const o = e as Record<string, unknown>
    const v = num(o.ftp) ?? num(o.icu_ftp)
    return v && v > 0 ? v : undefined
  }

  // A settings block that names a cycling type wins; several sports can share
  // one block, and running has its own FTP that must not be used here.
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const types = (e as { types?: unknown }).types
    if (Array.isArray(types) && types.some((t) => typeof t === 'string' && FTP_SPORTS.has(t))) {
      const v = ftpOf(e)
      if (v !== undefined) return v
    }
  }

  // Nothing declared its sport — take the only FTP on offer rather than none.
  return entries.length === 1 ? ftpOf(entries[0]) : undefined
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

const cache = new Map<string, { at: number; events: RawEvent[]; ftp?: number }>()

/** Empties the cache. Used by the force path and by tests. */
export function clearIntervalsCache(): void {
  cache.clear()
}

export type PlannedWeek = {
  sessions: PlannedSession[]
  /**
   * The FTP the watt targets were scaled against, if one was found.
   *
   * Handed back rather than kept private because the settings screen shows the
   * coefficients applied to a real ride, and a ride's size is FTP × time. An
   * invented FTP would make that preview a different athlete's.
   */
  ftp: number | undefined
}

export async function fetchPlannedSessions(
  creds: IntervalsCredentials,
  from: string,
  to: string,
  opts: { force?: boolean } = {},
): Promise<PlannedWeek> {
  const key = `${creds.athleteId}:${from}:${to}`
  if (opts.force) cache.delete(key)

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { sessions: normaliseEvents(hit.events, hit.ftp), ftp: hit.ftp }
  }

  // Both in flight together: the FTP request cannot fail the sync, so there is
  // nothing to sequence and no reason to pay for two round trips.
  const [events, fetched] = await Promise.all([
    fetchRawEvents(creds, from, to),
    fetchAthleteFtp(creds),
  ])
  cache.set(key, { at: Date.now(), events, ftp: fetched })

  const sessions = normaliseEvents(events, fetched)
  // Failing the athlete lookup, the FTP recovered from an event is just as
  // real — and on the recorded week it is the only one there was.
  const ftp = fetched ?? resolveFtp(events[0] ?? {}, docOf(events[0]))
  return { sessions, ftp }
}

function docOf(raw: RawEvent | undefined): Record<string, unknown> | null {
  return (raw?.workout_doc ?? null) as Record<string, unknown> | null
}
