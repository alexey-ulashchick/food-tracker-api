import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  CACHE_TTL_MS,
  IntervalsError,
  type RawEvent,
  clearIntervalsCache,
  fetchPlannedSessions,
  fetchRawEvents,
  normaliseEvent,
  normaliseEvents,
  stepIntensity,
} from '../src/integrations/intervals.ts'
import { classifyRide } from '../src/lib/trainingLoad.ts'

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
    ftp: 250,
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

describe('stepIntensity', () => {
  test('reads a percentage of FTP', () => {
    expect(stepIntensity({ units: '%ftp', value: 92 }, 250)).toBe(0.92)
  })

  test('takes the midpoint of a ramp', () => {
    expect(stepIntensity({ units: '%ftp', start: 90, end: 94 }, 250)).toBe(0.92)
  })

  test('converts watts using the plan own FTP', () => {
    expect(stepIntensity({ units: 'w', value: 230 }, 250)).toBe(0.92)
  })

  test('gives up on watts with no FTP rather than guessing', () => {
    expect(stepIntensity({ units: 'w', value: 230 }, undefined)).toBeUndefined()
  })

  test('disambiguates a unitless target by magnitude', () => {
    expect(stepIntensity({ value: 65 }, 250)).toBe(0.65)
    expect(stepIntensity({ value: 0.65 }, 250)).toBe(0.65)
  })

  test('returns nothing for a step with no power target', () => {
    // A free-ride or cadence block. Inventing an intensity would be worse
    // than leaving it out of the classification.
    expect(stepIntensity(undefined, 250)).toBeUndefined()
    expect(stepIntensity({ units: '%ftp' }, 250)).toBeUndefined()
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
        ftp: 250,
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
    globalThis.fetch = mock(async () => {
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
    expect(second[0]?.kj).toBe(1678)
  })
})
