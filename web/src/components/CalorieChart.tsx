import type { CalorieDay } from '@/lib/calorieMetrics'
import { CHART_VISIBLE_DAYS, calorieYDomain, goalExtension } from '@/lib/calorieMetrics'
import { dayMonth } from '@/lib/dates'
import { useElementWidth } from '@/lib/useElementWidth'
import { dietDayColor, label, palette, radius, surface, withAlpha } from '@/theme/tokens'
import type { DietDayColor } from '@shared/types.ts'
import { curveMonotoneX, line } from 'd3-shape'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// Hand-rolled SVG rather than a chart library. The Swift original layers a
// BarMark, two LineMarks with different styles, a RuleMark and a positioned
// annotation, and drives the whole thing off chartXSelection — reproducing that
// faithfully in a general-purpose library costs more than drawing it.
//
// A scrolling strip rather than a paged window. The two ‹ › buttons moved the
// window a fortnight at a time, which meant the answer to "what did last month
// look like" was four clicks and a re-fetch each. Now the day column is a fixed
// width — the plot divided by CHART_VISIBLE_DAYS, so the density matches the
// original on every screen — and reaching the left edge loads the page before it.
//
// The Y axis lives in its own fixed SVG beside the scroller. Inside it, the
// labels would scroll away from the bars they label.

/** Exported so History's loading placeholder reserves the real height. */
export const CHART_HEIGHT = 200
const PAD = { top: 8, bottom: 20 }
/** Width of the fixed axis gutter, matching the old PAD.left. */
const AXIS_W = 34
/** BarMark(width: .ratio(0.55)). */
const BAR_RATIO = 0.55
/**
 * AxisMarks(values: .stride(by: .day, count: 7)).
 *
 * Ticks are counted back from the newest day so the rightmost is always
 * labelled. That makes CHART_PAGE_DAYS a multiple of this a hidden requirement:
 * prepending a whole number of weeks leaves every existing day's tick where it
 * was, and prepending 30 days would shuffle the labels on every page load.
 */
const X_TICK_EVERY = 7
/** AxisMarks(values: .automatic(desiredCount: 3)). */
const Y_TICKS = 3
/** How close to the left edge counts as asking for older days. */
const LOAD_THRESHOLD_PX = 240

export type ChartDay = CalorieDay & { color: DietDayColor | null }

export type ChartApi = { scrollToEnd: () => void }

type Props = {
  /** Ascending by date, oldest first. */
  days: ChartDay[]
  /** Called when the strip is scrolled near its left edge. */
  onLoadOlder?: () => void
  /** Draws a spinner in the gutter while an older page is in flight. */
  loadingOlder?: boolean
  /** Reports the visible span so the card header can label it. */
  onViewChange?: (view: { from: string; to: string; atEnd: boolean }) => void
  /** Lets the header scroll the strip back to today. */
  apiRef?: React.RefObject<ChartApi | null>
}

export function CalorieChart({ days, onLoadOlder, loadingOlder, onViewChange, apiRef }: Props) {
  // Measured, not assumed. The old seed of 320 was not merely stale on a wide
  // screen: preserveAspectRatio defaults to `xMidYMid meet`, so a 320-wide
  // viewBox in a 700px box drew the chart at 320px floating in the middle with
  // dead space either side.
  const [frameRef, plotW] = useElementWidth<HTMLDivElement>()
  const [selected, setSelected] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom
  const { lo, hi } = calorieYDomain(days)

  // The band is a fixed column, not the plot divided by the day count — that is
  // what makes the strip scrollable instead of squeezing more days into the same
  // space as they load.
  const step = plotW > 0 ? plotW / CHART_VISIBLE_DAYS : 0
  const contentW = step * days.length
  const bandX = (i: number) => step * i + step / 2
  const y = (v: number) => PAD.top + plotH - ((v - lo) / Math.max(1e-9, hi - lo)) * plotH

  const barW = step * BAR_RATIO
  const realGoals = days.filter((d) => d.goal != null)
  const extension = goalExtension(days)

  const goalPath = line<{ i: number; goal: number }>()
    .x((p) => bandX(p.i))
    .y((p) => y(p.goal))
    .curve(curveMonotoneX)

  const goalPoints = days
    .map((d, i) => ({ i, goal: d.goal }))
    .filter((p): p is { i: number; goal: number } => p.goal != null)

  const extensionPoints = extension
    .map((e) => ({ i: days.findIndex((d) => d.date === e.date), goal: e.goal }))
    .filter((p) => p.i >= 0)

  const selectedIndex = selected ? days.findIndex((d) => d.date === selected) : -1
  const selectedDay = selectedIndex >= 0 ? days[selectedIndex] : null

  // Anchoring. Older days are prepended, which pushes everything right by their
  // width; without a matching scrollLeft the view would jump back in time on
  // every page. Measured from scrollWidth rather than computed from the page
  // size, so it stays exact if a page comes back short.
  const anchor = useRef({ days: 0, scrollWidth: 0, pinnedToEnd: true })

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || step === 0) return

    const previous = anchor.current
    const grew = days.length > previous.days
    const widthDelta = el.scrollWidth - previous.scrollWidth

    if (previous.days === 0) {
      // First paint opens at today, at the right-hand end.
      el.scrollLeft = el.scrollWidth
    } else if (grew && widthDelta > 0) {
      el.scrollLeft += widthDelta
    } else if (previous.pinnedToEnd) {
      // A resize changed the band width; keep the end pinned if it was.
      el.scrollLeft = el.scrollWidth
    }

    anchor.current = { ...previous, days: days.length, scrollWidth: el.scrollWidth }
  }, [days.length, step])

  // One stable callback. An inline arrow here would be a new function every
  // render, which makes React detach and reattach the ref — and useElementWidth
  // builds a fresh ResizeObserver on every attach.
  const attachScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el
      frameRef(el)
    },
    [frameRef],
  )

  const lastReported = useRef('')
  const report = useCallback(
    (el: HTMLDivElement) => {
      if (step === 0 || days.length === 0) return
      const first = Math.max(0, Math.floor(el.scrollLeft / step))
      const last = Math.min(days.length - 1, Math.ceil((el.scrollLeft + el.clientWidth) / step) - 1)
      const atEnd = el.scrollWidth - el.scrollLeft - el.clientWidth < step
      anchor.current.pinnedToEnd = atEnd

      const from = days[first]?.date
      const to = days[last]?.date
      if (!from || !to) return

      // Deduped here rather than trusted to the caller. `days` is rebuilt every
      // render, so this callback's identity changes every render, so the effect
      // below re-runs every render — and a parent that stored a fresh object
      // each time would re-render on its own report, forever.
      const key = `${from}|${to}|${atEnd}`
      if (key === lastReported.current) return
      lastReported.current = key
      onViewChange?.({ from, to, atEnd })
    },
    [days, step, onViewChange],
  )

  // Coalesced to one read per frame: a drag fires scroll continuously, and each
  // handler reads layout.
  const frame = useRef(0)
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (frame.current !== 0) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      report(el)
      if (el.scrollLeft < LOAD_THRESHOLD_PX) onLoadOlder?.()
    })
  }

  useLayoutEffect(() => {
    return () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
    }
  }, [])

  useLayoutEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      scrollToEnd: () => {
        const el = scroller.current
        if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
      },
    }
  }, [apiRef])

  // Report once the first page has been laid out, so the header has a span to
  // show before the user touches anything.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && step > 0 && days.length > 0) report(el)
  }, [report, step, days.length])

  /** Maps a pointer position onto the nearest day, in content coordinates. */
  function pick(clientX: number) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || step === 0) return
    // rect.left already moves with the scroll, so no scrollLeft term here.
    const index = Math.floor((clientX - rect.left) / step)
    const day = days[Math.max(0, Math.min(days.length - 1, index))]
    setSelected(day?.date ?? null)
  }

  return (
    <div style={{ position: 'relative', display: 'flex', height: CHART_HEIGHT }}>
      {/* Fixed gutter: the Y labels must not scroll away from their gridlines.
          Hidden from assistive tech — the plot beside it carries the label, and
          three bare numbers add nothing a screen reader can use. */}
      <svg
        width={AXIS_W}
        height={CHART_HEIGHT}
        aria-hidden="true"
        style={{ flexShrink: 0, display: 'block' }}
      >
        {plotW > 0
          ? yTicks(lo, hi, Y_TICKS).map((v) => (
              <text
                key={v}
                x={AXIS_W - 6}
                y={y(v)}
                textAnchor="end"
                dominantBaseline="middle"
                fill={label.secondary}
                style={{ fontWeight: 400, fontSize: 'calc(9px * var(--type))' }}
              >
                {Math.round(v)}
              </text>
            ))
          : null}
      </svg>

      <div ref={attachScroller} className="chart-strip" onScroll={onScroll}>
        {/* Nothing is drawn until the frame has been measured: at width 0 every
            bar, tick and scrub position would be wrong. */}
        {plotW > 0 ? (
          <svg
            ref={svgRef}
            width={contentW}
            height={CHART_HEIGHT}
            viewBox={`0 0 ${contentW} ${CHART_HEIGHT}`}
            // Scrubbing, the web equivalent of chartXSelection. The strip owns
            // horizontal drags now, so a mouse scrubs on move while a finger
            // scrubs only while held: once the drag becomes a scroll the browser
            // fires pointercancel, which is what clears the tooltip.
            style={{ display: 'block' }}
            onPointerDown={(e) => pick(e.clientX)}
            onPointerMove={(e) => {
              if (e.pointerType === 'mouse') pick(e.clientX)
            }}
            onPointerUp={(e) => {
              if (e.pointerType !== 'mouse') setSelected(null)
            }}
            onPointerCancel={() => setSelected(null)}
            onPointerLeave={() => setSelected(null)}
            role="img"
            aria-label="График калорий по дням"
          >
            {/* Y gridlines span the whole strip, so they read as continuous
                against the fixed labels beside them. */}
            {yTicks(lo, hi, Y_TICKS).map((v) => (
              <line
                key={v}
                x1={0}
                x2={contentW}
                y1={y(v)}
                y2={y(v)}
                stroke={surface.hairline}
                strokeWidth={1}
              />
            ))}

            {/* Bars. A bar is emitted for every day, including days with no data:
                it keeps the slot width stable and anchors the base to the domain
                floor, which matters because the domain does not include zero. */}
            {days.map((d, i) => {
              const top = d.eaten ?? lo
              const h = Math.max(0, y(lo) - y(top))
              return (
                <rect
                  key={d.date}
                  x={bandX(i) - barW / 2}
                  y={y(top)}
                  width={barW}
                  height={h}
                  rx={radius.bar}
                  fill={dietDayColor[d.color ?? 'gray']}
                />
              )
            })}

            {/* Configured goal: dashed, in the calorie tint. */}
            {goalPoints.length > 1 ? (
              <path
                d={goalPath(goalPoints) ?? ''}
                fill="none"
                stroke={withAlpha(palette.calories[1], 0.85)}
                strokeWidth={1.5}
                strokeDasharray="3 3"
              />
            ) : null}

            {/* Projection of the last known goal into days that have none. */}
            {extensionPoints.length > 1 && realGoals.length > 0 ? (
              <path
                d={goalPath(extensionPoints) ?? ''}
                fill="none"
                stroke="rgba(142,142,147,0.55)"
                strokeWidth={1.2}
              />
            ) : null}

            {/* Scrub line */}
            {selectedIndex >= 0 ? (
              <line
                x1={bandX(selectedIndex)}
                x2={bandX(selectedIndex)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="rgba(255,255,255,0.22)"
                strokeWidth={1}
              />
            ) : null}

            {/* X labels every seventh day, counted from the newest so the
                rightmost day is always labelled however far back you scroll. */}
            {days.map((d, i) =>
              (days.length - 1 - i) % X_TICK_EVERY === 0 ? (
                <text
                  key={`x-${d.date}`}
                  x={bandX(i)}
                  y={CHART_HEIGHT - 6}
                  textAnchor="middle"
                  fill={label.secondary}
                  style={{ fontWeight: 400, fontSize: 'calc(9px * var(--type))' }}
                >
                  {dayMonth(d.date)}
                </text>
              ) : null,
            )}
          </svg>
        ) : null}
      </div>

      {loadingOlder ? (
        <span
          style={{
            position: 'absolute',
            left: AXIS_W + 4,
            top: PAD.top,
            fontWeight: 500,
            fontSize: 'calc(9px * var(--type))',
            color: label.secondary,
            pointerEvents: 'none',
          }}
        >
          загружаю…
        </span>
      ) : null}

      {selectedDay ? (
        <Tooltip
          day={selectedDay}
          x={AXIS_W + bandX(selectedIndex) - (scroller.current?.scrollLeft ?? 0)}
          width={AXIS_W + plotW}
        />
      ) : null}
    </div>
  )
}

function Tooltip({ day, x, width }: { day: ChartDay; x: number; width: number }) {
  const W = 132
  // Keep the card inside the plot, matching overflowResolution: .fit(to: .chart).
  const left = Math.max(4, Math.min(width - W - 4, x - W / 2))

  return (
    <div
      style={{
        position: 'absolute',
        top: 4,
        left,
        width: W,
        background: surface.elevated,
        borderRadius: radius.tooltip,
        boxShadow: `0 2px 6px rgba(0,0,0,0.5), inset 0 0 0 0.5px ${surface.subtle}`,
        padding: '6px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{ fontWeight: 600, fontSize: 'calc(10px * var(--type))', color: label.secondary }}
      >
        {dayMonth(day.date)}
      </span>
      <span
        className="tnum"
        style={{
          fontWeight: 700,
          fontSize: 'calc(13px * var(--type))',
          color: palette.calories[1],
        }}
      >
        {day.eaten == null ? '—' : `${Math.round(day.eaten)} ккал`}
      </span>
      <span
        className="tnum"
        style={{ fontWeight: 400, fontSize: 'calc(10px * var(--type))', color: label.secondary }}
      >
        цель {day.goal == null ? '—' : Math.round(day.goal)}
      </span>
    </div>
  )
}

/** Round tick values inside [lo, hi], `count` of them. */
function yTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo
  if (span <= 0) return [lo]
  const rawStep = span / (count - 1)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = Math.ceil(rawStep / magnitude) * magnitude
  const start = Math.ceil(lo / step) * step

  const out: number[] = []
  for (let v = start; v <= hi; v += step) out.push(v)
  return out
}
