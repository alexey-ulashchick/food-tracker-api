import { listWeights } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { ScreenHeader } from '@/components/ScreenHeader'
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
    <div
      style={{
        padding: `${layout.screenTop}px ${layout.screenX}px ${layout.screenBottom}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: layout.cardGap,
      }}
    >
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
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span className="tnum" style={{ font: '700 44px inherit' }}>
                {formatKg(latest.kg)}
              </span>
              <span style={{ font: '600 16px inherit', color: label.secondary }}>кг</span>
              {delta != null ? <DeltaPill delta={delta} /> : null}
              {slope != null ? <TrendPill slope={slope} /> : null}
            </div>
            <WeightChart weeks={weeks} />
          </>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              font: '400 13px inherit',
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
    </div>
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
        font: '600 11px inherit',
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
        font: '600 11px inherit',
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
  if (weeks.length < 2) {
    return (
      <div
        style={{
          height: CHART_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          font: '400 12px inherit',
          color: label.secondary,
        }}
      >
        Нужно минимум две недели измерений, чтобы построить график.
      </div>
    )
  }

  const W = 320
  const { lo, hi } = weightYDomain(weeks)
  const x = (i: number) => (i / (weeks.length - 1)) * W
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
    <svg
      width="100%"
      height={CHART_HEIGHT}
      viewBox={`0 0 ${W} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
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
        // preserveAspectRatio="none" stretches strokes horizontally; this keeps
        // the line an even width whatever the container is.
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
