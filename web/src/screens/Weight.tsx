import { listWeights } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { Page } from '@/components/Page'
import { ScreenHeader } from '@/components/ScreenHeader'
import { useElementWidth } from '@/lib/useElementWidth'
import {
  formatKg,
  formatTrend,
  latestWeight,
  trendKgPerWeek,
  trendTone,
  weekDelta,
  weeklyAverages,
  weightYDomain,
} from '@/lib/weight'
import { ScaleIcon, Spinner, TrendArrowIcon } from '@/theme/icons'
import { label, layout, palette, radius, surface, withAlpha } from '@/theme/tokens'
import { useQuery } from '@tanstack/react-query'
import { area, curveMonotoneX, line } from 'd3-shape'

// Port of CalTracker/WeightView.swift, read-only.
//
// Dropped from the original: the hard-coded four-row "recent readings" list and
// LogWeightSheet, whose Save wrote nothing anywhere. Weight now arrives through
// POST /weights, which the user's own sync script drives.

const CHART_HEIGHT = 140

export function Weight() {
  const query = useQuery({ queryKey: qk.weights, queryFn: () => listWeights() })
  const points = (query.data ?? []).map((w) => ({ date: w.date, kg: w.kg }))

  const weeks = weeklyAverages(points)
  const latest = latestWeight(points)
  const delta = weekDelta(points)
  const slope = trendKgPerWeek(points)

  return (
    <Page>
      <ScreenHeader title="Вес" trailing={query.isFetching ? <Spinner /> : null} />

      <section
        style={{
          background: surface.card,
          borderRadius: radius.card,
          padding: layout.cardPadWide,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {latest ? (
          // The reading and the chart stack on a phone and sit side by side on
          // a desktop, where a 140px chart under a 44px number leaves the right
          // half of the card empty.
          <div className="weight-split">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span
                className="tnum"
                style={{ fontWeight: 700, fontSize: 'calc(44px * var(--type))' }}
              >
                {formatKg(latest.kg)}
              </span>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 'calc(16px * var(--type))',
                  color: label.secondary,
                }}
              >
                кг
              </span>
              {delta != null ? <DeltaPill delta={delta} /> : null}
              {slope != null ? <TrendPill slope={slope} /> : null}
            </div>
            <WeightChart weeks={weeks} />
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontWeight: 400,
              fontSize: 'calc(13px * var(--type))',
              color: label.secondary,
              minHeight: 60,
            }}
          >
            {query.isLoading ? (
              <>
                <Spinner />
                Загружаю…
              </>
            ) : (
              <>
                <ScaleIcon size={16} />
                Данных о весе пока нет. Их пишет внешний скрипт через POST /weights.
              </>
            )}
          </div>
        )}
      </section>
    </Page>
  )
}

function DeltaPill({ delta }: { delta: number }) {
  const down = delta < 0
  const color = down ? palette.carbs[1] : '#FF9F0A'
  return (
    <span
      className="tnum"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontWeight: 600,
        fontSize: 'calc(11px * var(--type))',
        color,
        background: withAlpha(color, 0.15),
        borderRadius: 999,
        padding: '2px 6px',
      }}
    >
      <TrendArrowIcon dir={down ? 'down' : 'up'} size={9} />
      {down ? '−' : '+'}
      {formatKg(Math.abs(delta))} кг за неделю
    </span>
  )
}

function TrendPill({ slope }: { slope: number }) {
  const down = trendTone(slope) === 'down'
  const color = down ? palette.carbs[1] : '#FF9F0A'
  return (
    <span
      className="tnum"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontWeight: 600,
        fontSize: 'calc(11px * var(--type))',
        color,
        background: withAlpha(color, 0.15),
        borderRadius: 999,
        padding: '2px 6px',
      }}
    >
      <TrendArrowIcon dir={down ? 'down' : 'up'} size={9} />
      тренд {formatTrend(slope)}
    </span>
  )
}

function WeightChart({ weeks }: { weeks: Array<{ weekStart: string; avgKg: number }> }) {
  // Before the early return: a hook cannot sit behind a condition.
  const [frameRef, width] = useElementWidth<HTMLDivElement>()

  if (weeks.length < 2) {
    return (
      <div
        style={{
          height: CHART_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          fontWeight: 400,
          fontSize: 'calc(12px * var(--type))',
          color: label.secondary,
        }}
      >
        Нужно минимум две недели измерений, чтобы построить график.
      </div>
    )
  }

  // Real pixels, so the curve keeps its aspect. The chart used to draw into a
  // fixed 320-wide viewBox stretched with preserveAspectRatio="none", which
  // smeared the curve horizontally at every width but 320 — and needed
  // vectorEffect to stop the stroke smearing with it.
  const { lo, hi } = weightYDomain(weeks)
  // Inset by half the stroke: at x(0) = 0 and x(n-1) = W the 2.4px line lost
  // half its width off each edge.
  const INSET = 2
  const plotW = Math.max(1, width - INSET * 2)
  const x = (i: number) => INSET + (i / (weeks.length - 1)) * plotW
  const y = (kg: number) => CHART_HEIGHT - ((kg - lo) / Math.max(1e-9, hi - lo)) * CHART_HEIGHT

  const points = weeks.map((w, i) => ({ i, kg: w.avgKg }))
  const linePath = line<{ i: number; kg: number }>()
    .x((p) => x(p.i))
    .y((p) => y(p.kg))
    .curve(curveMonotoneX)
  const areaPath = area<{ i: number; kg: number }>()
    .x((p) => x(p.i))
    .y0(CHART_HEIGHT)
    .y1((p) => y(p.kg))
    .curve(curveMonotoneX)

  return (
    <div ref={frameRef} style={{ width: '100%', height: CHART_HEIGHT }}>
      {/* Nothing until measured: at width 0 every point sits on the y axis. */}
      {width > 0 ? (
        <svg
          width="100%"
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          style={{ display: 'block' }}
          role="img"
          aria-label="График веса по неделям"
        >
          <defs>
            <linearGradient id="weight-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={withAlpha(palette.calories[1], 0.32)} />
              <stop offset="100%" stopColor={withAlpha(palette.calories[1], 0)} />
            </linearGradient>
          </defs>
          <path d={areaPath(points) ?? ''} fill="url(#weight-fill)" />
          <path
            d={linePath(points) ?? ''}
            fill="none"
            stroke={palette.calories[1]}
            strokeWidth={2.4}
          />
        </svg>
      ) : null}
    </div>
  )
}
