// Date helpers. Two rules that the Swift client learned the hard way:
//
//   * A calendar key must come from the LOCAL date, never from toISOString():
//     west of UTC that yields tomorrow's date for most of the evening.
//   * Day arithmetic walks the ISO string, not Date objects — string maths
//     sidesteps DST, exactly as dateRange() does in src/routes/day-summary.ts.

/** YYYY-MM-DD in the viewer's own calendar. */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now)
}

/** Parses YYYY-MM-DD as a LOCAL midnight, not a UTC one. */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

export function addDays(iso: string, days: number): string {
  const d = fromIsoDate(iso)
  d.setDate(d.getDate() + days)
  return toIsoDate(d)
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function diffDays(a: string, b: string): number {
  const ms = fromIsoDate(b).getTime() - fromIsoDate(a).getTime()
  return Math.round(ms / 86_400_000)
}

/** Inclusive on both ends, ascending. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) out.push(cursor)
  return out
}

// ── Display formatting ────────────────────────────────────────────────────
// Everything user-facing is ru-RU. Formatters are cached because the History
// list builds one label per row.

const cache = new Map<string, Intl.DateTimeFormat>()

function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options)
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', options)
    cache.set(key, f)
  }
  return f
}

/** "чт, 4 сент." — the Today subtitle. */
export function weekdayShortDate(iso: string): string {
  return fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(fromIsoDate(iso))
}

/** "четверг" — the History row title. */
export function weekdayLong(iso: string): string {
  return fmt({ weekday: 'long' }).format(fromIsoDate(iso))
}

/** "4 сент." — chart range ends. */
export function dayMonth(iso: string): string {
  return fmt({ day: 'numeric', month: 'short' }).format(fromIsoDate(iso))
}

/** "сент." — the month column in a History row. */
export function monthShort(iso: string): string {
  return fmt({ month: 'short' }).format(fromIsoDate(iso))
}

/** Day of month with no padding, for the History row's big number. */
export function dayOfMonth(iso: string): string {
  return String(fromIsoDate(iso).getDate())
}

/**
 * "Сегодня" / "Вчера" / "Завтра", else the weekday — the Today screen title.
 * Capitalised because it heads the screen.
 */
export function relativeDayTitle(iso: string, today: string = todayIso()): string {
  const delta = diffDays(today, iso)
  if (delta === 0) return 'Сегодня'
  if (delta === -1) return 'Вчера'
  if (delta === 1) return 'Завтра'
  const weekday = weekdayLong(iso)
  return weekday.charAt(0).toUpperCase() + weekday.slice(1)
}
