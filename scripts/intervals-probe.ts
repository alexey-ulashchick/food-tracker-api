#!/usr/bin/env bun
//
// Read-only probe for the intervals.icu API.
//
// Nothing in this repo has ever talked to intervals.icu, so the exact field
// names of a planned event are unverified: `joules` or `icu_joules`, what
// shape `workout_doc.steps` takes, which `type` a strength session carries.
// Guessing them would mean debugging through a deploy.
//
// This script fetches one window of planned events, prints a census of every
// field that actually came back, and records the raw response as a fixture.
// src/lib/trainingLoad.ts and its tests are written against that fixture.
//
// Usage:
//   bun scripts/intervals-probe.ts --key <api-key> --athlete i123456
//   bun run intervals:probe -- --key <api-key> --athlete i123456
//
//   # or put INTERVALS_API_KEY / INTERVALS_ATHLETE_ID in .env and just:
//   bun run intervals:probe
//
// Options:
//   --from / --to   YYYY-MM-DD window. Default: 14 days back, 21 days forward.
//   --out           Fixture path. Default: tests/fixtures/intervals-events.json
//   --no-write      Census only, write nothing.
//   --explain       Also run the normaliser and the coefficient table over the
//                   response, so you can check the classification against what
//                   intervals.icu shows you.
//
// The key is never printed and never written to the fixture. The raw dump
// DOES contain whatever you typed into your own workout names and
// descriptions — read it before committing.

// Imports only pure modules. Reaching for src/db/client.ts would drag in
// src/env.ts, which exits the process unless DATABASE_URL and
// ANTHROPIC_API_KEY are set — neither of which this script needs.
import { normaliseEvents } from '../src/integrations/intervals.ts'
import { scoreRide } from '../src/lib/trainingLoad.ts'

const args = process.argv.slice(2)

let key = process.env.INTERVALS_API_KEY
let athlete = process.env.INTERVALS_ATHLETE_ID
let from: string | undefined
let to: string | undefined
let out = 'tests/fixtures/intervals-events.json'
let write = true
let explain = false

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--key' || a === '-k') key = args[++i]
  else if (a === '--athlete' || a === '-a') athlete = args[++i]
  else if (a === '--from') from = args[++i]
  else if (a === '--to') to = args[++i]
  else if (a === '--out' || a === '-o') out = args[++i] ?? out
  else if (a === '--no-write') write = false
  else if (a === '--explain') explain = true
  else if (a === '--help' || a === '-h') {
    printUsage()
    process.exit(0)
  }
}

if (!key || !athlete) {
  console.error('Missing credentials.')
  console.error()
  printUsage()
  process.exit(1)
}

const today = new Date().toISOString().slice(0, 10)
from ??= shiftDays(today, -14)
to ??= shiftDays(today, 21)

// Basic auth with the literal username "API_KEY" and the key as the password —
// intervals.icu's documented scheme.
const authorization = `Basic ${btoa(`API_KEY:${key}`)}`
const url = `https://intervals.icu/api/v1/athlete/${athlete}/events?oldest=${from}&newest=${to}`

console.log(`GET ${url}`)
console.log()

const res = await fetch(url, { headers: { Authorization: authorization } })

if (!res.ok) {
  // The body can echo the request; print it, but never the key.
  const body = (await res.text()).replaceAll(key, '<redacted>')
  console.error(`HTTP ${res.status} ${res.statusText}`)
  console.error(body.slice(0, 1000))
  process.exit(1)
}

const payload: unknown = await res.json()
if (!Array.isArray(payload)) {
  console.error('Expected a JSON array of events, got:', typeof payload)
  console.error(JSON.stringify(payload).slice(0, 500))
  process.exit(1)
}

const events = payload as Array<Record<string, unknown>>
console.log(`${events.length} events in ${from} … ${to}`)
console.log()

if (events.length === 0) {
  console.log('Nothing planned in this window — widen it with --from / --to.')
  process.exit(0)
}

// ── Field census ───────────────────────────────────────────────────────────
// Which keys exist at all, how often they carry a value, and what one looks
// like. This is the whole point of the script: the parser is written against
// the columns that are actually populated, not the ones the docs mention.

console.log('─ fields ─────────────────────────────────────────────────────────')
console.log(pad('key', 28), pad('non-null', 10), 'sample')

const keys = [...new Set(events.flatMap((e) => Object.keys(e)))].sort()
for (const k of keys) {
  const values = events.map((e) => e[k]).filter((v) => v !== null && v !== undefined)
  console.log(pad(k, 28), pad(`${values.length}/${events.length}`, 10), preview(values[0]))
}

// ── Enumerations we branch on ──────────────────────────────────────────────

console.log()
console.log('─ distinct values ────────────────────────────────────────────────')
for (const k of ['type', 'category', 'sub_type']) {
  if (!keys.includes(k)) continue
  const seen = tally(events.map((e) => e[k]))
  console.log(pad(k, 28), seen)
}

// ── Anything that could be the planned energy ──────────────────────────────
// The coefficient table multiplies planned kilojoules, so finding the right
// column is the single fact this probe exists to establish.

console.log()
console.log('─ energy-ish fields ──────────────────────────────────────────────')
const energyKeys = keys.filter((k) => /joule|kj|energy|calor|work/i.test(k))
if (energyKeys.length === 0) {
  console.log('  none — planned kJ may live inside workout_doc, see below')
}
for (const k of energyKeys) {
  const values = events.map((e) => e[k]).filter((v) => typeof v === 'number') as number[]
  const range = values.length > 0 ? `${Math.min(...values)} … ${Math.max(...values)}` : '—'
  console.log(pad(k, 28), pad(`${values.length}/${events.length}`, 10), range)
}

// ── workout_doc, where the steps live ──────────────────────────────────────

console.log()
console.log('─ workout_doc ────────────────────────────────────────────────────')
const withDoc = events.filter((e) => e.workout_doc && typeof e.workout_doc === 'object')
console.log(`  ${withDoc.length}/${events.length} events carry one`)

if (withDoc.length > 0) {
  const docKeys = [
    ...new Set(withDoc.flatMap((e) => Object.keys(e.workout_doc as object))),
  ].sort()
  console.log(`  keys: ${docKeys.join(', ')}`)

  const firstSteps = withDoc
    .map((e) => (e.workout_doc as Record<string, unknown>).steps)
    .find((s) => Array.isArray(s) && s.length > 0) as unknown[] | undefined

  if (firstSteps) {
    console.log()
    console.log('  first non-empty steps array, verbatim:')
    console.log(indent(JSON.stringify(firstSteps, null, 2), 4))
  } else {
    console.log('  no populated `steps` array found — check the keys above')
  }
}

// ── Eyeball table ──────────────────────────────────────────────────────────
// So you can compare the numbers against what intervals.icu shows you.

console.log()
console.log('─ events ─────────────────────────────────────────────────────────')
console.log(pad('date', 12), pad('type', 16), pad('minutes', 9), pad('kJ', 8), 'name')
for (const e of events) {
  const seconds = num(e.moving_time) ?? num(e.duration)
  const joules = num(e.joules) ?? num(e.icu_joules)
  console.log(
    pad(String(e.start_date_local ?? '?').slice(0, 10), 12),
    pad(String(e.type ?? e.category ?? '?'), 16),
    pad(seconds === undefined ? '—' : Math.round(seconds / 60), 9),
    pad(joules === undefined ? '—' : Math.round(joules / 1000), 8),
    String(e.name ?? '').slice(0, 48),
  )
}

// ── How the app reads it ───────────────────────────────────────────────────
// The census above says what came back; this says what was understood. A row
// reading `unknown` is the parser telling you it found no usable steps.

if (explain) {
  console.log()
  console.log('─ as the app reads it ────────────────────────────────────────────')
  console.log(pad('date', 12), pad('kind', 10), pad('class', 10), pad('coeff', 7), pad('kJ', 7), pad('kcal', 7), 'name')

  for (const s of normaliseEvents(events)) {
    if (s.kind === 'ride') {
      const r = scoreRide(s)
      console.log(
        pad(s.date, 12),
        pad(s.kind, 10),
        pad(r.kind, 10),
        pad(r.coeff, 7),
        pad(Math.round(r.kj), 7),
        pad(r.kcal, 7),
        `${s.name} · ${s.steps.length} steps`,
      )
    } else {
      console.log(
        pad(s.date, 12),
        pad(s.kind, 10),
        pad('—', 10),
        pad('—', 7),
        pad('—', 7),
        pad(s.kind === 'strength' ? 250 : 0, 7),
        s.name,
      )
    }
  }
}

// ── Fixture ────────────────────────────────────────────────────────────────

if (write) {
  await Bun.write(out, `${JSON.stringify(events, null, 2)}\n`)
  console.log()
  console.log(`Wrote ${events.length} events to ${out}`)
  console.log('Read it before committing — it contains your own workout names and notes.')
}

process.exit(0)

// ── helpers ────────────────────────────────────────────────────────────────

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function pad(v: unknown, width: number): string {
  return String(v).padEnd(width)
}

function preview(v: unknown): string {
  if (v === undefined) return '—'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 60 ? `${s.slice(0, 57)}…` : s
}

function tally(values: unknown[]): string {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (v === null || v === undefined) continue
    const k = String(v)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join('  ')
}

function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n')
}

function printUsage() {
  console.log('Usage:')
  console.log('  bun scripts/intervals-probe.ts --key <api-key> --athlete <id>')
  console.log()
  console.log('Options:')
  console.log('  --key, -k       intervals.icu API key, or $INTERVALS_API_KEY')
  console.log('  --athlete, -a   Athlete id like i123456, or $INTERVALS_ATHLETE_ID')
  console.log('  --from --to     YYYY-MM-DD window (default: -14d … +21d)')
  console.log('  --out, -o       Fixture path (default: tests/fixtures/intervals-events.json)')
  console.log('  --no-write      Print the census, write no fixture')
  console.log('  --explain       Also show how the app classifies each session')
  console.log()
  console.log('Find both under Settings → Developer at https://intervals.icu.')
}
