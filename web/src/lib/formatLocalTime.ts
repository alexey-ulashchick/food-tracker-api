/**
 * Renders a meal's timestamp as HH:mm in the timezone where it was EATEN, not
 * where the viewer currently is. Port of formatLocalTime in Models.swift:65.
 *
 * When that timezone differs from the device's, a short "GMT±N" hint is
 * appended — otherwise a Moscow breakfast reads as an early-morning meal once
 * the user lands in LA.
 *
 * `offsetMin` is minutes east of UTC. Null on rows logged before the column
 * existed, in which case the device's current offset is used so old data keeps
 * displaying as it always has.
 */

// The Swift version built a fresh DateFormatter on every call, and it is called
// once per meal row. Here the formatter is cached per offset.
const formatters = new Map<number, Intl.DateTimeFormat>()

function formatterFor(offsetMin: number): Intl.DateTimeFormat {
  let f = formatters.get(offsetMin)
  if (!f) {
    // Intl has no "fixed offset" zone, so the instant is shifted by the offset
    // and then read back in UTC.
    f = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })
    formatters.set(offsetMin, f)
  }
  return f
}

export function gmtSuffix(offsetMin: number): string {
  const sign = offsetMin >= 0 ? '+' : '−'
  const abs = Math.abs(offsetMin)
  const hours = Math.floor(abs / 60)
  const mins = abs % 60
  return mins === 0 ? `GMT${sign}${hours}` : `GMT${sign}${hours}:${String(mins).padStart(2, '0')}`
}

export function formatLocalTime(
  timestamp: string,
  offsetMin: number | null,
  now: Date = new Date(),
): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''

  const deviceOffset = -now.getTimezoneOffset()
  const effective = offsetMin ?? deviceOffset

  const shifted = new Date(parsed.getTime() + effective * 60_000)
  const time = formatterFor(effective).format(shifted)

  // A legacy row has nothing to disagree with, and a matching offset needs no
  // hint either.
  if (offsetMin === null || effective === deviceOffset) return time
  return `${time} ${gmtSuffix(effective)}`
}
