import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  CACHE_TTL_MS,
  IntervalsError,
  type RawEvent,
  clearIntervalsCache,
  fetchAthleteFtp,
  fetchPlannedSessions,
  fetchRawEvents,
  normaliseEvent,
  normaliseEvents,
  pickCyclingFtp,
  resolveFtp,
  stepTarget,
} from '../src/integrations/intervals.ts'
import { classifyRide, scoreRide } from '../src/lib/trainingLoad.ts'

// Two halves. The normaliser is pure and tested against events shaped the way
// scripts/intervals-probe.ts records them — it is the piece that has to
// survive the real wire format, so everything it tolerates is pinned here.
// The HTTP half stubs globalThis.fetch: there is no fetch anywhere else in
// src/, so there is nothing for mock.module to intercept, and a global swap
// with a restore is both smaller and more honest than a seam invented for one
// call site.

const realFetch = globalThis.fetch

/** The rejection of a promise that is expected to reject. */
async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p
    throw new Error('expected a rejection')
  } catch (e) {
    return e as Error
  }
}

afterEach(() => {
  globalThis.fetch = realFetch
  clearIntervalsCache()
})

// A planned sweet-spot session, as intervals.icu describes one.
const SS_EVENT: RawEvent = {
  id: 1,
  start_date_local: '2026-09-12T00:00:00',
  category: 'WORKOUT',
  type: 'Ride',
  name: '3x12 SS',
  moving_time: 4500,
  joules: 1_678_000,
  workout_doc: {
    steps: [
      { duration: 900, power: { units: '%ftp', value: 55 } },
      {
        reps: 3,
        steps: [
          { duration: 720, power: { units: '%ftp', start: 90, end: 94 } },
          { duration: 300, power: { units: '%ftp', value: 55 } },
        ],
      },
      { duration: 600, power: { units: '%ftp', value: 55 } },
    ],
  },
}

describe('stepTarget', () => {
  test('reads a percentage of FTP, and the watts it implies', () => {
    expect(stepTarget({ units: '%ftp', value: 92 }, 250)).toEqual({ intensity: 0.92, watts: 230 })
  })

  test('takes the midpoint of a ramp', () => {
    expect(stepTarget({ units: '%ftp', start: 90, end: 94 }, 250).intensity).toBe(0.92)
  })

  test('converts watts using FTP', () => {
    expect(stepTarget({ units: 'w', value: 230 }, 250)).toEqual({ intensity: 0.92, watts: 230 })
  })

  test('keeps the watts even with no FTP to scale them', () => {
    // Unscalable for classification, but still countable as work — which is
    // what lets planned kilojoules be summed when the event omits them.
    expect(stepTarget({ units: 'w', value: 230 }, undefined)).toEqual({ watts: 230 })
  })

  test('a percentage with no FTP yields an intensity but no watts', () => {
    expect(stepTarget({ units: '%ftp', value: 92 }, undefined)).toEqual({ intensity: 0.92 })
  })

  test('disambiguates a unitless target by magnitude', () => {
    expect(stepTarget({ value: 65 }, 250).intensity).toBe(0.65)
    expect(stepTarget({ value: 0.65 }, 250).intensity).toBe(0.65)
  })

  test('returns nothing for a step with no power target', () => {
    // A free-ride or cadence block. Inventing a target would be worse than
    // leaving it out of the classification.
    expect(stepTarget(undefined, 250)).toEqual({})
    expect(stepTarget({ units: '%ftp' }, 250)).toEqual({})
  })
})

describe('normaliseEvent', () => {
  test('expands repeats so time-in-band adds up', () => {
    const s = normaliseEvent(SS_EVENT)
    // 1 warm-up + 3×2 + 1 cool-down.
    expect(s?.steps).toHaveLength(8)
    expect(s?.steps.filter((x) => x.intensity > 0.8)).toHaveLength(3)
    // And the classification that motivated the whole defining-block rule.
    expect(classifyRide(s?.steps ?? [])).toBe('threshold')
  })

  test('takes the date from the athlete own calendar, with no offset maths', () => {
    expect(normaliseEvent(SS_EVENT)?.date).toBe('2026-09-12')
  })

  test('converts joules to kilojoules', () => {
    expect(normaliseEvent(SS_EVENT)?.kj).toBe(1678)
  })

  test('accepts icu_joules under its other name', () => {
    const s = normaliseEvent({ ...SS_EVENT, joules: undefined, icu_joules: 900_000 })
    expect(s?.kj).toBe(900)
  })

  test('leaves kj absent when the plan carries none', () => {
    const { joules, ...rest } = SS_EVENT
    expect(joules).toBeDefined()
    expect(normaliseEvent(rest)?.kj).toBeUndefined()
  })

  test('reports minutes from moving_time', () => {
    expect(normaliseEvent(SS_EVENT)?.minutes).toBe(75)
  })

  test('classifies rides, strength and everything else', () => {
    expect(normaliseEvent(SS_EVENT)?.kind).toBe('ride')
    expect(normaliseEvent({ ...SS_EVENT, type: 'VirtualRide' })?.kind).toBe('ride')
    expect(normaliseEvent({ ...SS_EVENT, type: 'WeightTraining' })?.kind).toBe('strength')
    expect(normaliseEvent({ ...SS_EVENT, type: 'Run' })?.kind).toBe('other')
    // `Workout` is intervals.icu's catch-all, so it must NOT earn the bonus.
    expect(normaliseEvent({ ...SS_EVENT, type: 'Workout' })?.kind).toBe('other')
  })

  test('a note or a holiday can never add calories', () => {
    expect(normaliseEvent({ ...SS_EVENT, category: 'NOTE' })?.kind).toBe('other')
    expect(normaliseEvent({ ...SS_EVENT, category: 'HOLIDAY' })?.kind).toBe('other')
    // A race is training.
    expect(normaliseEvent({ ...SS_EVENT, category: 'RACE_A' })?.kind).toBe('ride')
  })

  test('an event with no structure yields no steps rather than failing', () => {
    const s = normaliseEvent({
      start_date_local: '2026-09-13T00:00:00',
      type: 'Ride',
      name: 'Утренний выезд',
      moving_time: 7200,
    })
    expect(s?.steps).toEqual([])
    expect(s?.name).toBe('Утренний выезд')
  })

  test('drops an event with no usable date', () => {
    expect(normaliseEvent({ type: 'Ride', name: 'x' })).toBeNull()
    expect(normaliseEvent({ start_date_local: 'not-a-date', type: 'Ride' })).toBeNull()
  })

  test('skips distance-based and zero-length steps', () => {
    const s = normaliseEvent({
      ...SS_EVENT,
      workout_doc: {
        steps: [
          { distance: 5000, power: { units: '%ftp', value: 65 } },
          { duration: 0, power: { units: '%ftp', value: 65 } },
          { duration: 600, power: { units: '%ftp', value: 65 } },
        ],
      },
    })
    expect(s?.steps).toEqual([{ seconds: 600, intensity: 0.65 }])
  })

  test('names an unnamed session rather than showing a blank row', () => {
    expect(normaliseEvent({ start_date_local: '2026-09-13T00:00:00', type: 'Ride' })?.name).toBe(
      'Тренировка',
    )
  })

  test('normaliseEvents drops the unusable and keeps the rest', () => {
    expect(normaliseEvents([SS_EVENT, { type: 'Ride' }, SS_EVENT])).toHaveLength(2)
  })
})

// ── A real response ────────────────────────────────────────────────────────
// Recorded by scripts/intervals-probe.ts from a live account, trimmed to one
// event. This is the fixture that matters: the first implementation read
// `workout_doc.ftp`, which this account does not send, so every watt target
// was unscalable and every ride came back unclassified.

const REP = {
  reps: 10,
  text: '10x',
  distance: 0,
  duration: 450,
  steps: [
    { power: { units: 'w', value: 275 }, duration: 30 },
    { power: { units: 'w', value: 115 }, duration: 15 },
  ],
}

const REAL_STEPS = [
  { warmup: true, duration: 600, freeride: true },
  { power: { end: 162, start: 135, units: 'w' }, duration: 600 },
  ...[245, 115, 250, 115, 255, 115, 260, 115, 275, 115].map((v) => ({
    power: { units: 'w', value: v },
    duration: 30,
  })),
  { duration: 180, freeride: true },
  REP,
  { duration: 180, freeride: true },
  REP,
  { duration: 180, freeride: true },
  REP,
  { cooldown: true, duration: 600, freeride: true },
]

/** Named "VO2Max 3x10 30/15" by the athlete, so the expected class is known. */
const REAL_EVENT: RawEvent = {
  start_date_local: '2026-09-14T00:00:00',
  category: 'WORKOUT',
  type: 'Ride',
  name: 'VO2Max 3x10 30/15',
  moving_time: 3990,
  joules: 444_150,
  icu_intensity: 81.15704,
  workout_doc: { normalized_power: 202.9, duration: 3990, steps: REAL_STEPS },
}

describe('a watt-based plan, as intervals.icu actually sends one', () => {
  test('recovers FTP from normalised power and intensity', () => {
    // No `ftp` in workout_doc and `icu_ftp` null on the event, so the only way
    // to scale watts is IF = NP / FTP, rearranged.
    expect(Math.round(resolveFtp(REAL_EVENT, REAL_EVENT.workout_doc as never)!)).toBe(250)
  })

  test('classifies the session its own name describes', () => {
    const s = normaliseEvent(REAL_EVENT)
    expect(classifyRide(s?.steps ?? [])).toBe('vo2max')
    expect(scoreRide(s!).coeff).toBe(0.95)
  })

  test('scales every watt step, leaving none unscaled', () => {
    const s = normaliseEvent(REAL_EVENT)
    // 1 ramp + 10 alternations + 3 × 10 × 2 inside the repeats. The free-ride
    // blocks name no target and are correctly absent.
    expect(s?.steps).toHaveLength(71)
    expect(s?.unscaledSteps).toBe(0)
  })

  test('the summed step work reproduces intervals.icu own figure exactly', () => {
    // The strongest available check that the flattening is complete: expanding
    // the repeats, taking the ramp's midpoint and skipping free-ride blocks all
    // have to be right for watts × seconds to land on 444150 J to the joule.
    const { joules, ...withoutJoules } = REAL_EVENT
    expect(joules).toBe(444_150)
    expect(normaliseEvent(withoutJoules)?.kj).toBeCloseTo(444.15, 2)
  })

  test('falls back to the summed work when joules is missing', () => {
    // Not hypothetical: one ride in the recorded week had no `joules`, and its
    // day was computed as the base alone before this.
    const { joules, ...withoutJoules } = REAL_EVENT
    expect(joules).toBeDefined()
    const s = normaliseEvent(withoutJoules)
    expect(Math.round(s?.kj ?? 0)).toBe(444)
    expect(scoreRide(s!).kcal).toBeGreaterThan(0)
  })

  test('prefers the sent figure over the summed one', () => {
    expect(normaliseEvent(REAL_EVENT)?.kj).toBe(444.15)
  })

  test('says FTP is missing rather than pretending there was no plan', () => {
    // Same event with nothing to recover FTP from. The steps are still there,
    // so "no plan" would be the wrong story and points at the wrong fix.
    const s = normaliseEvent({
      ...REAL_EVENT,
      icu_intensity: undefined,
      workout_doc: { duration: 3990, steps: REAL_STEPS },
    })
    expect(s?.steps).toHaveLength(0)
    expect(s?.unscaledSteps).toBe(71)
    expect(scoreRide(s!).kind).toBe('needs_ftp')
    expect(scoreRide(s!).coeff).toBe(0.7)
  })

  test('a ride with no plan at all is still a different story', () => {
    const s = normaliseEvent({
      start_date_local: '2026-09-14T00:00:00',
      type: 'Ride',
      name: 'Freeride',
      moving_time: 3600,
    })
    expect(s?.unscaledSteps).toBe(0)
    expect(scoreRide(s!).kind).toBe('unknown')
  })
})

describe('where FTP comes from', () => {
  const doc = (over: Record<string, unknown> = {}) => ({ normalized_power: 202.9, ...over })
  const event = (over: RawEvent = {}) => ({ icu_intensity: 81.15704, ...over }) as RawEvent

  test('the plan own figure wins, being the one its watts were written against', () => {
    expect(resolveFtp(event(), doc({ ftp: 300 }), 250)).toBe(300)
  })

  test('then the athlete figure from intervals.icu', () => {
    expect(resolveFtp(event(), doc(), 260)).toBe(260)
  })

  test('and failing both, it is recovered from the event itself', () => {
    // IF = NP / FTP, so FTP = NP / IF. Verified against a real account.
    expect(Math.round(resolveFtp(event(), doc())!)).toBe(250)
  })

  test('undefined when there is nothing at all to go on', () => {
    expect(
      resolveFtp(event({ icu_intensity: undefined }), doc({ normalized_power: undefined })),
    ).toBeUndefined()
  })

  test('a zero is not a figure', () => {
    expect(resolveFtp(event(), doc({ ftp: 0 }), 0)).toBeCloseTo(250, 0)
  })
})

describe('pickCyclingFtp', () => {
  test('takes the block that names a cycling sport', () => {
    // Running has its own FTP and must not be used to scale a ride.
    expect(
      pickCyclingFtp([
        { types: ['Run'], ftp: 300 },
        { types: ['Ride', 'VirtualRide'], ftp: 250 },
      ]),
    ).toBe(250)
  })

  test('accepts a single object as well as a list', () => {
    expect(pickCyclingFtp({ types: ['Ride'], ftp: 250 })).toBe(250)
  })

  test('accepts icu_ftp under its other name', () => {
    expect(pickCyclingFtp([{ types: ['Ride'], icu_ftp: 250 }])).toBe(250)
  })

  test('takes an unlabelled figure only when it is the only one', () => {
    expect(pickCyclingFtp({ ftp: 250 })).toBe(250)
    // Two unlabelled blocks: no way to tell which sport, so neither.
    expect(pickCyclingFtp([{ ftp: 250 }, { ftp: 300 }])).toBeUndefined()
  })

  test('shrugs at a shape it does not recognise', () => {
    expect(pickCyclingFtp(null)).toBeUndefined()
    expect(pickCyclingFtp([])).toBeUndefined()
    expect(pickCyclingFtp([{ types: ['Ride'] }])).toBeUndefined()
    expect(pickCyclingFtp('nope')).toBeUndefined()
  })
})

describe('fetchAthleteFtp', () => {
  test('reads the cycling FTP', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      expect(String(input)).toContain('/sport-settings')
      return new Response(JSON.stringify([{ types: ['Ride'], ftp: 250 }]), { status: 200 })
    }) as unknown as typeof fetch

    expect(await fetchAthleteFtp({ athleteId: 'i1', apiKey: 'k' })).toBe(250)
  })

  test('never throws, whatever happens', async () => {
    // A sync must not fail because this one extra request did — resolveFtp has
    // a fallback underneath it that is known to work.
    for (const stub of [
      async () => new Response('', { status: 500 }),
      async () => new Response('not json', { status: 200 }),
      async () => {
        throw new Error('offline')
      },
    ]) {
      globalThis.fetch = stub as unknown as typeof fetch
      expect(await fetchAthleteFtp({ athleteId: 'i1', apiKey: 'k' })).toBeUndefined()
    }
  })
})

describe('fetchRawEvents', () => {
  test('uses Basic auth with the literal API_KEY username', async () => {
    let seen: { url: string; auth: string } | null = null
    globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
      seen = {
        url: String(input),
        auth: String((init?.headers as Record<string, string>).Authorization),
      }
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch

    await fetchRawEvents({ athleteId: 'i123', apiKey: 'secret-key' }, '2026-09-01', '2026-09-30')

    expect(seen!.url).toBe(
      'https://intervals.icu/api/v1/athlete/i123/events?oldest=2026-09-01&newest=2026-09-30',
    )
    expect(seen!.auth).toBe(`Basic ${btoa('API_KEY:secret-key')}`)
  })

  test('says plainly that the credentials were rejected', async () => {
    globalThis.fetch = mock(
      async () => new Response('nope', { status: 403 }),
    ) as unknown as typeof fetch

    const err = await caught(fetchRawEvents({ athleteId: 'i1', apiKey: 'k'.repeat(10) }, 'a', 'b'))
    expect(err).toBeInstanceOf(IntervalsError)
    expect((err as IntervalsError).status).toBe(403)
    expect(err.message).toContain('rejected the credentials')
  })

  test('never puts the key in the error', async () => {
    globalThis.fetch = mock(
      async () => new Response('', { status: 500 }),
    ) as unknown as typeof fetch

    const key = 'super-secret-key'
    const err = await caught(fetchRawEvents({ athleteId: 'i1', apiKey: key }, 'a', 'b'))
    expect(err.message).not.toContain(key)
  })

  test('treats a non-list body as an upstream failure', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: 'x' }), { status: 200 }),
    ) as unknown as typeof fetch

    expect(fetchRawEvents({ athleteId: 'i1', apiKey: 'k' }, 'a', 'b')).rejects.toThrow(
      'not a list of events',
    )
  })
})

describe('the cache', () => {
  let calls = 0

  beforeEach(() => {
    calls = 0
    // Counted per endpoint, not per request: a sync also asks for the
    // athlete's FTP, and a bare tally would make this test about how many
    // requests the implementation happens to make.
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/sport-settings')) {
        return new Response(JSON.stringify([{ types: ['Ride'], ftp: 250 }]), { status: 200 })
      }
      calls++
      return new Response(JSON.stringify([SS_EVENT]), { status: 200 })
    }) as unknown as typeof fetch
  })

  const creds = { athleteId: 'i1', apiKey: 'k' }

  test('a second call inside the window does not hit the network', async () => {
    await fetchPlannedSessions(creds, '2026-09-01', '2026-09-30')
    await fetchPlannedSessions(creds, '2026-09-01', '2026-09-30')
    expect(calls).toBe(1)
  })

  test('a different window is a different entry', async () => {
    await fetchPlannedSessions(creds, '2026-09-01', '2026-09-30')
    await fetchPlannedSessions(creds, '2026-10-01', '2026-10-30')
    expect(calls).toBe(2)
  })

  test('force bypasses it — this is what the refresh button is for', async () => {
    await fetchPlannedSessions(creds, '2026-09-01', '2026-09-30')
    await fetchPlannedSessions(creds, '2026-09-01', '2026-09-30', { force: true })
    expect(calls).toBe(2)
  })

  test('the window is five minutes', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000)
  })

  test('still returns the parsed sessions on a hit', async () => {
    const first = await fetchPlannedSessions(creds, '2026-09-01', '2026-09-30')
    const second = await fetchPlannedSessions(creds, '2026-09-01', '2026-09-30')
    expect(second).toEqual(first)
    expect(second.sessions[0]?.kj).toBe(1678)
  })

  test('hands back the FTP it scaled with, so the settings screen can show it', () => {
    // Fixed example kilojoules would price the coefficients for someone else.
    return fetchPlannedSessions(creds, '2026-09-01', '2026-09-30').then((week) => {
      expect(week.ftp).toBe(250)
    })
  })
})
