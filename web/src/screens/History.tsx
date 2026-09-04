import { daySummaries, listGoals, listMeals } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { CalorieChart, type ChartDay } from '@/components/CalorieChart'
import { ScreenHeader } from '@/components/ScreenHeader'
import { MacroRing } from '@/components/ring/MacroRing'
import {
  CHART_PAGE_DAYS,
  type WeekRollup,
  balanceKcal,
  balanceTone,
  buildCalorieDays,
  buildDayTotals,
  calorieMetrics,
  chartWindow,
  compliance,
  formatBalance,
  formatFatEquivalent,
  metricsRange,
} from '@/lib/calorieMetrics'
import { addDays, dayMonth, dayOfMonth, monthShort, todayIso, weekdayLong } from '@/lib/dates'
import { useUi } from '@/store/ui'
import { ChevronIcon, FlameIcon, Spinner, TrayIcon } from '@/theme/icons'
import {
  dietDayColor,
  label,
  layout,
  palette,
  radius,
  singleRingSpec,
  surface,
  withAlpha,
} from '@/theme/tokens'
import type { ServerDaySummary, ServerGoal, ServerMeal } from '@shared/types.ts'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

// Port of CalTracker/HistoryView.swift: the calorie chart, the two-row metrics
// card, and a paginated list of past days.

const PAGE_DAYS = 14
const MAX_LOOKBACK_DAYS = 730
const MAX_EMPTY_PAGES = 3

const DAY_TYPE_RU: Record<string, string> = { training: 'Тренировочный', rest: 'Отдых' }

export function History() {
  const today = todayIso()
  const [offset, setOffset] = useState(0)

  // Every goal in one request. The Swift version fanned out one
  // GET /goals?date= per day that had meals — up to 14 per page.
  const goalsQuery = useQuery({ queryKey: qk.goalsAll, queryFn: listGoals })

  const window = chartWindow(today, offset)
  const chartMealsQuery = useQuery({
    queryKey: qk.meals(window.from, window.to),
    queryFn: () => listMeals(window.from, window.to),
  })
  const chartVerdictQuery = useQuery({
    queryKey: qk.daySummaries(window.from, window.to),
    queryFn: () => daySummaries(window.from, window.to),
    retry: false,
  })

  const metricsSpan = metricsRange(today)
  const metricsMealsQuery = useQuery({
    queryKey: qk.meals(metricsSpan.from, metricsSpan.to),
    queryFn: () => listMeals(metricsSpan.from, metricsSpan.to),
  })

  const goals = goalsQuery.data ?? []
  const chartDays = buildChartDays(
    window,
    chartMealsQuery.data ?? [],
    goals,
    chartVerdictQuery.data ?? [],
  )
  const metrics =
    metricsMealsQuery.data && goalsQuery.data
      ? calorieMetrics(buildDayTotals(metricsMealsQuery.data, goals), today)
      : null

  const loading = chartMealsQuery.isFetching || goalsQuery.isFetching

  return (
    <div
      style={{
        padding: `${layout.screenTop}px ${layout.screenX}px ${layout.screenBottom}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: layout.cardGap,
      }}
    >
      <ScreenHeader title="История" trailing={loading ? <Spinner /> : null} />

      <section
        style={{
          background: surface.card,
          borderRadius: radius.card,
          padding: layout.cardPad,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <ChartHeader
          from={window.from}
          to={window.to}
          offset={offset}
          onShift={(d) => setOffset((o) => o + d)}
          onReset={() => setOffset(0)}
        />
        {chartMealsQuery.isLoading ? (
          <div
            style={{
              height: 180,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              font: '400 12px inherit',
              color: label.secondary,
            }}
          >
            <Spinner />
            Загружаю…
          </div>
        ) : (
          <CalorieChart days={chartDays} />
        )}
      </section>

      <MetricsCard metrics={metrics} />

      <SectionLabel>Прошедшие дни</SectionLabel>
      <PastDays goals={goals} today={today} />
    </div>
  )
}

function buildChartDays(
  window: { from: string; to: string },
  meals: ServerMeal[],
  goals: ServerGoal[],
  verdicts: ServerDaySummary[],
): ChartDay[] {
  const totals = buildDayTotals(meals, goals)
  const colorByDate = new Map(verdicts.map((v) => [v.date, v.color]))
  return buildCalorieDays(window.from, window.to, totals).map((d) => ({
    ...d,
    color: colorByDate.get(d.date) ?? null,
  }))
}

function ChartHeader({
  from,
  to,
  offset,
  onShift,
  onReset,
}: {
  from: string
  to: string
  offset: number
  onShift: (days: number) => void
  onReset: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            font: '600 11px inherit',
            color: label.secondary,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          Калории
        </span>
        <span className="tnum" style={{ font: '600 13px inherit' }}>
          {dayMonth(from)} – {dayMonth(to)}
        </span>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <PaginatorButton dir="left" onClick={() => onShift(-CHART_PAGE_DAYS)} />
        {offset !== 0 ? (
          <button
            type="button"
            onClick={onReset}
            style={{
              border: 0,
              borderRadius: 999,
              background: surface.subtle,
              color: label.primary,
              font: '600 11px inherit',
              padding: '5px 10px',
              cursor: 'pointer',
            }}
          >
            Сегодня
          </button>
        ) : null}
        <PaginatorButton dir="right" onClick={() => onShift(CHART_PAGE_DAYS)} />
      </div>
    </div>
  )
}

function PaginatorButton({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === 'left' ? 'Раньше' : 'Позже'}
      style={{
        width: 28,
        height: 28,
        border: 0,
        borderRadius: 999,
        background: surface.subtle,
        color: label.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <ChevronIcon dir={dir} size={12} />
    </button>
  )
}

function MetricsCard({ metrics }: { metrics: ReturnType<typeof calorieMetrics> | null }) {
  return (
    <section style={{ background: surface.card, borderRadius: radius.card }}>
      <MetricsRow title="Эта неделя" subtitle="Пн — сегодня" stat={metrics?.thisWeek ?? null} />
      <hr style={{ height: 1, background: surface.hairline, border: 0, margin: '0 0 0 16px' }} />
      <MetricsRow
        title="Последние 6 недель"
        subtitle="Предыдущие полные недели"
        stat={metrics?.lastSixWeeks ?? null}
        showFatHint
      />
    </section>
  )
}

function MetricsRow({
  title,
  subtitle,
  stat,
  showFatHint,
}: {
  title: string
  subtitle: string
  stat: WeekRollup | null
  showFatHint?: boolean
}) {
  const balance = stat ? balanceKcal(stat) : 0
  const tone = balanceTone(balance)
  const toneColor =
    tone === 'neutral' ? label.secondary : tone === 'surplus' ? '#FF9F0A' : palette.carbs[1]
  const fat = stat && showFatHint ? formatFatEquivalent(balance, 6) : null

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ font: '600 16px inherit' }}>{title}</span>
        <span style={{ font: '400 12.5px inherit', color: label.secondary }}>{subtitle}</span>
      </div>

      {stat ? (
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 4,
            textAlign: 'right',
          }}
        >
          <span className="tnum" style={{ font: '600 16px inherit', color: palette.carbs[1] }}>
            {stat.onTargetDays} / {stat.totalDays} в цели
          </span>
          <span
            style={{ display: 'flex', alignItems: 'baseline', gap: 6, font: '400 13px inherit' }}
          >
            <span className="tnum" style={{ color: toneColor }}>
              {formatBalance(balance)}
            </span>
            <span style={{ color: label.secondary }}>·</span>
            <span className="tnum" style={{ color: label.secondary }}>
              {Math.round(compliance(stat) * 100)}% попаданий
            </span>
          </span>
          {fat ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                font: '400 12px inherit',
                color: label.secondary,
              }}
            >
              <span style={{ color: '#FF9F0A', display: 'flex' }}>
                <FlameIcon size={10} />
              </span>
              <span className="tnum">≈ {fat} жира можно было сжечь</span>
            </span>
          ) : null}
        </div>
      ) : (
        <span style={{ marginLeft: 'auto' }}>
          <Spinner />
        </span>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        font: '600 12.5px inherit',
        color: label.secondary,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        paddingLeft: 4,
      }}
    >
      {children}
    </span>
  )
}

type DaySummaryRow = {
  date: string
  kcal: number
  ratios: { protein: number | null; carbs: number | null; fat: number | null }
  goal: ServerGoal | null
  mealNames: string[]
  mealCount: number
  color: string
}

function PastDays({ goals, today }: { goals: ServerGoal[]; today: string }) {
  const navigate = useNavigate()
  const setViewingDate = useUi((s) => s.setViewingDate)
  const goalByDate = new Map(goals.map((g) => [g.date, g]))

  // Pages walk backwards a fortnight at a time. `pageParam` is the exclusive
  // upper bound of the page about to load.
  const query = useInfiniteQuery({
    queryKey: ['history-pages'],
    initialPageParam: today,
    queryFn: async ({ pageParam }) => {
      const to = pageParam as string
      const from = addDays(to, -(PAGE_DAYS - 1))
      const [meals, verdicts] = await Promise.all([
        listMeals(from, to),
        daySummaries(from, to).catch(() => [] as ServerDaySummary[]),
      ])
      return { from, to, meals, verdicts }
    },
    getNextPageParam: (last, allPages) => {
      const emptyRun = countTrailingEmptyPages(allPages)
      const walked = allPages.length * PAGE_DAYS
      if (emptyRun >= MAX_EMPTY_PAGES || walked >= MAX_LOOKBACK_DAYS) return undefined
      return addDays(last.from, -1)
    },
  })

  const rows = (query.data?.pages ?? []).flatMap((page) =>
    summariseDays(page.meals, page.verdicts, goalByDate),
  )

  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage])

  if (query.isLoading) return <PastDaysSkeleton />
  if (query.isError) {
    return (
      <div
        style={{
          background: surface.card,
          borderRadius: radius.card,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <span style={{ font: '400 13px inherit', color: label.secondary }}>
          Не удалось загрузить историю.
        </span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          style={{
            alignSelf: 'flex-start',
            border: 0,
            borderRadius: radius.field,
            background: surface.subtle,
            color: label.primary,
            font: '600 13px inherit',
            padding: '8px 12px',
            cursor: 'pointer',
          }}
        >
          Повторить
        </button>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div
        style={{
          background: surface.card,
          borderRadius: radius.card,
          padding: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          font: '400 13px inherit',
          color: label.secondary,
        }}
      >
        <TrayIcon size={15} />
        Пока нет записанных дней
      </div>
    )
  }

  return (
    <section style={{ background: surface.card, borderRadius: radius.card, overflow: 'hidden' }}>
      {rows.map((row, i) => (
        <div key={row.date}>
          <PastDayRow
            row={row}
            onOpen={() => {
              setViewingDate(row.date)
              navigate('/')
            }}
          />
          {i < rows.length - 1 ? (
            <hr
              style={{ height: 1, background: surface.hairline, border: 0, margin: '0 0 0 16px' }}
            />
          ) : null}
        </div>
      ))}

      <div ref={sentinel} />

      <div
        style={{
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          font: '400 11px inherit',
          color: label.secondary,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        }}
      >
        {query.isFetchingNextPage ? (
          <>
            <Spinner />
            Загружаю более старые дни…
          </>
        ) : query.hasNextPage ? null : (
          'Это начало вашей истории'
        )}
      </div>
    </section>
  )
}

function countTrailingEmptyPages(pages: Array<{ meals: ServerMeal[] }>): number {
  let run = 0
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i]!.meals.length > 0) break
    run++
  }
  return run
}

function summariseDays(
  meals: ServerMeal[],
  verdicts: ServerDaySummary[],
  goalByDate: Map<string, ServerGoal>,
): DaySummaryRow[] {
  const byDay = new Map<string, ServerMeal[]>()
  for (const m of meals) {
    const bucket = byDay.get(m.localDate)
    if (bucket) bucket.push(m)
    else byDay.set(m.localDate, [m])
  }
  const colorByDate = new Map(verdicts.map((v) => [v.date, v.color]))

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, dayMeals]) => {
      const totals = dayMeals.reduce(
        (a, m) => ({
          kcal: a.kcal + m.calories,
          protein: a.protein + m.protein,
          carbs: a.carbs + m.carbs,
          fat: a.fat + m.fats,
        }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      )
      const goal = goalByDate.get(date) ?? null
      // A null ratio means "no goal for this day", which the row renders as a
      // dimmed ring rather than a misleading 0%.
      const ratio = (value: number, target: number | undefined) =>
        target && target > 0 ? value / target : null

      return {
        date,
        kcal: totals.kcal,
        ratios: {
          protein: ratio(totals.protein, goal?.proteinGGoal),
          carbs: ratio(totals.carbs, goal?.carbsGGoal),
          fat: ratio(totals.fat, goal?.fatGGoal),
        },
        goal,
        mealNames: [...dayMeals]
          .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
          .slice(0, 2)
          .map((m) => m.foodName),
        mealCount: dayMeals.length,
        color: colorByDate.get(date) ?? 'gray',
      }
    })
}

function PastDayRow({ row, onOpen }: { row: DaySummaryRow; onOpen: () => void }) {
  const [pressed, setPressed] = useState(false)
  const spec = singleRingSpec.historyRow
  const note =
    row.mealNames.length > 0
      ? row.mealNames.join(', ') + (row.mealCount > 2 ? ` +${row.mealCount - 2}` : '')
      : ''

  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        width: '100%',
        border: 0,
        // PastDayRowButtonStyle: a faint white wash while held.
        background: pressed ? 'rgba(255,255,255,0.04)' : 'transparent',
        color: label.primary,
        font: 'inherit',
        textAlign: 'left',
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 38,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <span
          style={{
            font: '600 11px inherit',
            color: label.secondary,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          {monthShort(row.date)}
        </span>
        <span className="tnum" style={{ font: '700 20px inherit' }}>
          {dayOfMonth(row.date)}
        </span>
      </span>

      {/* Three independent rings, not a nested stack — at 26px a stack
          collapses the innermost ring below its own stroke width. */}
      <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {(['protein', 'carbs', 'fat'] as const).map((key) => (
          <MacroRing
            key={key}
            value={row.ratios[key] ?? 0}
            stops={palette[key]}
            size={spec.size}
            strokeWidth={spec.strokeWidth}
            dimmed={row.ratios[key] == null}
          />
        ))}
      </span>

      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ font: '600 14px inherit' }}>
          {capitalise(weekdayLong(row.date))}
          {row.goal ? ` · ${DAY_TYPE_RU[row.goal.dayType] ?? row.goal.dayType}` : ''}
        </span>
        {note ? (
          <span
            style={{
              font: '400 11.5px inherit',
              color: label.secondary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {note}
          </span>
        ) : null}
      </span>

      <span
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        {/* Same colour as this day's bar in the chart above. The hairline ring
            keeps a `gray` verdict visible against the near-black row. */}
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 999,
            background: dietDayColor[row.color as keyof typeof dietDayColor] ?? dietDayColor.gray,
            boxShadow: '0 0 0 0.5px rgba(255,255,255,0.12)',
          }}
        />
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 1,
          }}
        >
          <span className="tnum" style={{ font: '600 15px inherit' }}>
            {Math.round(row.kcal)}
          </span>
          <span style={{ font: '400 10.5px inherit', color: label.secondary, letterSpacing: 0.3 }}>
            ККАЛ
          </span>
        </span>
        <span style={{ color: withAlpha('#EBEBF5', 0.3), display: 'flex' }}>
          <ChevronIcon dir="right" size={12} />
        </span>
      </span>
    </button>
  )
}

function PastDaysSkeleton() {
  return (
    <section style={{ background: surface.card, borderRadius: radius.card, overflow: 'hidden' }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <SkeletonBlock w={38} h={34} />
          <SkeletonBlock w={90} h={26} />
          <SkeletonBlock w={110} h={30} />
        </div>
      ))}
    </section>
  )
}

function SkeletonBlock({ w, h }: { w: number; h: number }) {
  return (
    <span
      className="skeleton"
      style={{ width: w, height: h, borderRadius: 6, display: 'block', flexShrink: 0 }}
    />
  )
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
