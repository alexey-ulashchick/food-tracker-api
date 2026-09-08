import type { CalorieDay } from '@/lib/calorieMetrics'
import { calorieYDomain, goalExtension } from '@/lib/calorieMetrics'
import { dayMonth } from '@/lib/dates'
import { dietDayColor, label, palette, radius, surface, withAlpha } from '@/theme/tokens'
import type { DietDayColor } from '@shared/types.ts'
import { curveMonotoneX, line } from 'd3-shape'
import { useRef, useState } from 'react'

// Hand-rolled SVG rather than a chart library. The Swift original layers a
// BarMark, two LineMarks with different styles, a RuleMark and a positioned
// annotation, and drives the whole thing off chartXSelection — reproducing that
// faithfully in a general-purpose library costs more than drawing it.

const HEIGHT = 200
const PAD = { top: 8, right: 4, bottom: 20, left: 34 }
/** BarMark(width: .ratio(0.55)). */
const BAR_RATIO = 0.55
/** AxisMarks(values: .stride(by: .day, count: 7)). */
const X_TICK_EVERY = 7
/** AxisMarks(values: .automatic(desiredCount: 3)). */
const Y_TICKS = 3

export type ChartDay = CalorieDay & { color: DietDayColor | null }

export function CalorieChart({ days }: { days: ChartDay[] }) {
  const [width, setWidth] = useState(320)
  const [selected, setSelected] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const plotW = Math.max(1, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const { lo, hi } = calorieYDomain(days)

  // Band scale by hand: d3-scale would do it, but the maths is two lines and
  // the bar geometry needs the step anyway.
  const step = plotW / Math.max(1, days.length)
  const bandX = (i: number) => PAD.left + step * i + step / 2
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

  /** Maps a pointer position onto the nearest day. */
  function pick(clientX: number) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = clientX - rect.left - PAD.left
    const index = Math.floor(x / step)
    const day = days[Math.max(0, Math.min(days.length - 1, index))]
    setSelected(day?.date ?? null)
  }

  return (
    <div
      style={{ position: 'relative', width: '100%' }}
      ref={(el) => {
        if (el && el.clientWidth > 0 && el.clientWidth !== width) setWidth(el.clientWidth)
      }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        // Scrubbing, the web equivalent of chartXSelection. touch-action keeps
        // a vertical drag scrolling the page instead of scrubbing.
        style={{ display: 'block', touchAction: 'pan-y' }}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerMove={(e) => {
          if (e.buttons > 0 || e.pointerType === 'mouse') pick(e.clientX)
        }}
        onPointerLeave={() => setSelected(null)}
        role="img"
        aria-label="График калорий по дням"
      >
        {/* Y grid + labels */}
        {yTicks(lo, hi, Y_TICKS).map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke={surface.hairline}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(v)}
              textAnchor="end"
              dominantBaseline="middle"
              fill={label.secondary}
              style={{ fontWeight: 400, fontSize: 9 }}
            >
              {Math.round(v)}
            </text>
          </g>
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

        {/* X labels every seventh day */}
        {days.map((d, i) =>
          i % X_TICK_EVERY === 0 ? (
            <text
              key={`x-${d.date}`}
              x={bandX(i)}
              y={HEIGHT - 6}
              textAnchor="middle"
              fill={label.secondary}
              style={{ fontWeight: 400, fontSize: 9 }}
            >
              {dayMonth(d.date)}
            </text>
          ) : null,
        )}
      </svg>

      {selectedDay ? <Tooltip day={selectedDay} x={bandX(selectedIndex)} width={width} /> : null}
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
      <span style={{ fontWeight: 600, fontSize: 10, color: label.secondary }}>
        {dayMonth(day.date)}
      </span>
      <span className="tnum" style={{ fontWeight: 700, fontSize: 13, color: palette.calories[1] }}>
        {day.eaten == null ? '—' : `${Math.round(day.eaten)} ккал`}
      </span>
      <span className="tnum" style={{ fontWeight: 400, fontSize: 10, color: label.secondary }}>
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
