import { daySummaries, getGoal, listMeals } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { CalorieMeter } from '@/components/CalorieMeter'
import { MacroPie } from '@/components/MacroPie'
import { RingStack } from '@/components/ring/RingStack'
import { addDays, relativeDayTitle, todayIso, weekdayShortDate } from '@/lib/dates'
import { formatLocalTime } from '@/lib/formatLocalTime'
import { useUi } from '@/store/ui'
import { ChevronIcon, ForkKnifeIcon, Spinner, TickIcon } from '@/theme/icons'
import {
  CHIP_BG_ALPHA,
  accent,
  dayTypeTint,
  dietDayColor,
  label,
  layout,
  palette,
  radius,
  ringSpec,
  surface,
  withAlpha,
} from '@/theme/tokens'
import { DIET_DAY_TITLES } from '@shared/dietDayTitles.ts'
import type { ServerDaySummary, ServerGoal, ServerMeal } from '@shared/types.ts'
import { useQuery } from '@tanstack/react-query'

// Port of CalTracker/TodayView.swift. Structure top to bottom: day header,
// calorie card with the day verdict, rings beside the macro rows, meals log.

const MEAL_RU: Record<string, string> = {
  Breakfast: 'Завтрак',
  Lunch: 'Обед',
  Dinner: 'Ужин',
  Snack: 'Перекус',
}

const DAY_TYPE_LABEL: Record<string, string> = {
  training: 'Тренировочный день',
  rest: 'День отдыха',
}

/** Seed targets, overwritten by the first /goals response — AppState.init. */
const SEED_GOAL = { calories: 2650, protein: 170, carbs: 330, fat: 74 }

type MacroRow = {
  key: 'protein' | 'carbs' | 'fat'
  name: string
  unit: string
  current: number
  goal: number
}

export function Today() {
  const viewingDate = useUi((s) => s.viewingDate)
  const setViewingDate = useUi((s) => s.setViewingDate)
  const resetToToday = useUi((s) => s.resetToToday)
  const today = todayIso()

  const goalQuery = useQuery({
    queryKey: qk.goal(viewingDate),
    queryFn: () => getGoal(viewingDate),
  })
  const mealsQuery = useQuery({
    queryKey: qk.meals(viewingDate, viewingDate),
    queryFn: () => listMeals(viewingDate, viewingDate),
  })
  // A failed verdict must not blank the screen — the rings and totals still
  // render, exactly as in the Swift version where this error was swallowed.
  const verdictQuery = useQuery({
    queryKey: qk.daySummaries(viewingDate, viewingDate),
    queryFn: () => daySummaries(viewingDate, viewingDate),
    retry: false,
  })

  const meals = mealsQuery.data ?? []
  const goal = goalQuery.data ?? null
  const verdict = verdictQuery.data?.[0] ?? null
  const busy = goalQuery.isFetching || mealsQuery.isFetching

  const eaten = sumMacros(meals)
  const targets = resolveTargets(goal)
  const dayType = goal?.dayType ?? 'training'

  const macroRows: MacroRow[] = [
    { key: 'protein', name: 'Белки', unit: 'г', current: eaten.protein, goal: targets.protein },
    { key: 'carbs', name: 'Углеводы', unit: 'г', current: eaten.carbs, goal: targets.carbs },
    { key: 'fat', name: 'Жиры', unit: 'г', current: eaten.fat, goal: targets.fat },
  ]

  return (
    <div
      style={{
        padding: `${layout.screenTop}px ${layout.screenX}px ${layout.screenBottom}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: layout.cardGap,
      }}
    >
      <DayHeader
        date={viewingDate}
        today={today}
        busy={busy}
        onShift={(days) => setViewingDate(addDays(viewingDate, days))}
        onReset={resetToToday}
      />

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
        <CalorieMeter
          current={eaten.calories}
          goal={targets.calories}
          stops={palette.calories}
          accessory={
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                font: '600 12.5px inherit',
                color: dayTypeTint[dayType],
                background: withAlpha(dayTypeTint[dayType], CHIP_BG_ALPHA),
                borderRadius: 999,
                padding: '6px 11px',
                whiteSpace: 'nowrap',
              }}
            >
              {DAY_TYPE_LABEL[dayType] ?? dayType}
            </span>
          }
        />
        <hr style={{ height: 1, background: surface.hairline, border: 0, margin: 0 }} />
        {verdict ? <Verdict verdict={verdict} /> : null}
      </section>

      <section
        style={{
          background: surface.card,
          borderRadius: radius.card,
          padding: layout.cardPad,
          display: 'flex',
          alignItems: 'center',
          gap: layout.cardPad,
        }}
      >
        <div style={{ position: 'relative', width: ringSpec.todayStack.size, flexShrink: 0 }}>
          <RingStack
            rings={macroRows.map((m) => ({
              value: m.goal > 0 ? m.current / m.goal : 0,
              stops: palette[m.key],
            }))}
            {...ringSpec.todayStack}
          />
          <RingCentre rows={macroRows} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {macroRows.map((m, i) => (
            <div key={m.key}>
              <MacroStatRow row={m} />
              {i < macroRows.length - 1 ? (
                <hr style={{ height: 1, background: surface.hairline, border: 0, margin: 0 }} />
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <MealsLog meals={meals} loading={mealsQuery.isLoading} />
    </div>
  )
}

function sumMacros(meals: ServerMeal[]) {
  return meals.reduce(
    (a, m) => ({
      calories: a.calories + m.calories,
      protein: a.protein + m.protein,
      carbs: a.carbs + m.carbs,
      fat: a.fat + m.fats,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  )
}

function resolveTargets(goal: ServerGoal | null) {
  if (!goal) return SEED_GOAL
  return {
    calories: goal.calorieGoal,
    protein: goal.proteinGGoal,
    carbs: goal.carbsGGoal,
    fat: goal.fatGGoal,
  }
}

function DayHeader({
  date,
  today,
  busy,
  onShift,
  onReset,
}: {
  date: string
  today: string
  busy: boolean
  onShift: (days: number) => void
  onReset: () => void
}) {
  const isToday = date === today
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <h1 style={{ font: '700 32px inherit', margin: 0, whiteSpace: 'nowrap' }}>
          {relativeDayTitle(date, today)}
        </h1>
        <span className="tnum" style={{ font: '500 13px inherit', color: label.secondary }}>
          {weekdayShortDate(date)}
        </span>
      </div>

      {busy ? <Spinner /> : null}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Only shown off today; one tap returns instead of clicking the
            chevrons back a day at a time. */}
        {!isToday ? (
          <button
            type="button"
            onClick={onReset}
            style={{
              height: 34,
              padding: '0 11px',
              border: 0,
              borderRadius: 999,
              background: withAlpha(accent, CHIP_BG_ALPHA),
              color: accent,
              font: '600 12.5px inherit',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Сегодня
          </button>
        ) : null}
        {/* Forward navigation is allowed on purpose — pre-logging a meal or
            setting tomorrow's goal both need it. */}
        <DayNavButton dir="left" onClick={() => onShift(-1)} />
        <DayNavButton dir="right" onClick={() => onShift(1)} />
      </div>
    </header>
  )
}

function DayNavButton({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === 'left' ? 'Предыдущий день' : 'Следующий день'}
      style={{
        width: 34,
        height: 34,
        border: 0,
        borderRadius: 999,
        background: surface.elevated,
        color: label.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <ChevronIcon dir={dir} size={14} />
    </button>
  )
}

function Verdict({ verdict }: { verdict: ServerDaySummary }) {
  const tint = dietDayColor[verdict.color]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: tint,
            boxShadow: '0 0 0 0.5px rgba(255,255,255,0.14)',
            flexShrink: 0,
          }}
        />
        <span style={{ font: '600 14px inherit' }}>
          {verdict.title || DIET_DAY_TITLES[verdict.color]}
        </span>
      </div>
      <span style={{ font: '400 12.5px inherit', color: label.secondary }}>{verdict.reason}</span>
    </div>
  )
}

/** The single tight stat inside the ring stack. */
function RingCentre({ rows }: { rows: MacroRow[] }) {
  const ratios = rows.map((m) => (m.goal > 0 ? m.current / m.goal : 0))
  const allHit = ratios.every((r) => r >= 1)

  const wrapper = {
    position: 'absolute' as const,
    inset: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none' as const,
  }

  if (allHit) {
    return (
      <div style={{ ...wrapper, gap: 4 }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 999,
            background: withAlpha('#34C759', 0.18),
            color: '#34C759',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <TickIcon size={16} />
        </span>
        <span
          style={{
            font: '600 10.5px inherit',
            color: label.secondary,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          Готово
        </span>
      </div>
    )
  }

  // The macro furthest from its target is the one worth calling out.
  let lowestIndex = 0
  for (let i = 1; i < ratios.length; i++) {
    if (ratios[i]! < ratios[lowestIndex]!) lowestIndex = i
  }
  const lowest = rows[lowestIndex]!
  const remaining = Math.max(0, Math.round(lowest.goal - lowest.current))

  return (
    <div style={{ ...wrapper, gap: 2 }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 1,
          color: palette[lowest.key][1],
        }}
      >
        <span className="tnum" style={{ font: '700 22px inherit' }}>
          +{remaining}
        </span>
        <span style={{ font: '600 12px inherit' }}>{lowest.unit}</span>
      </span>
      <span style={{ font: '500 10.5px inherit', color: label.secondary }}>
        {lowest.name.toLowerCase()}
      </span>
    </div>
  )
}

function MacroStatRow({ row }: { row: MacroRow }) {
  const ratio = row.goal > 0 ? row.current / row.goal : 0
  const over = ratio > 1
  const overAmount = Math.max(0, Math.round(row.current - row.goal))
  const tint = palette[row.key][1]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0' }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: tint, flexShrink: 0 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ font: '600 14px inherit' }}>{row.name}</span>
          {over ? (
            <span
              className="tnum"
              style={{
                font: '700 10px inherit',
                color: '#FF3B30',
                background: withAlpha('#FF3B30', 0.16),
                borderRadius: 999,
                padding: '1.5px 5px',
              }}
            >
              +{overAmount}
              {row.unit}
            </span>
          ) : null}
        </span>
        <span className="tnum" style={{ font: '400 12px inherit', color: label.secondary }}>
          {Math.round(row.current)} / {Math.round(row.goal)}
          {row.unit}
        </span>
      </div>
      <span
        className="tnum"
        style={{
          marginLeft: 'auto',
          font: '600 14px inherit',
          color: over ? '#FF3B30' : tint,
        }}
      >
        {Math.round(ratio * 100)}%
      </span>
    </div>
  )
}

function MealsLog({ meals, loading }: { meals: ServerMeal[]; loading: boolean }) {
  return (
    <section
      style={{
        background: surface.card,
        borderRadius: radius.card,
        paddingBottom: 6,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '14px 16px 10px',
        }}
      >
        <span
          style={{
            font: '600 13px inherit',
            color: label.secondary,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          Приёмы пищи
        </span>
        {meals.length > 0 ? (
          <span
            className="tnum"
            style={{ marginLeft: 'auto', font: '600 12px inherit', color: label.secondary }}
          >
            {meals.length}
          </span>
        ) : null}
      </div>

      {meals.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            font: '400 13px inherit',
            color: label.secondary,
          }}
        >
          {loading ? (
            <>
              <Spinner />
              Загружаю…
            </>
          ) : (
            <>
              <ForkKnifeIcon size={14} />
              Пока ничего не записано
            </>
          )}
        </div>
      ) : (
        meals.map((meal, i) => (
          <div key={meal.id}>
            <MealRow meal={meal} />
            {i < meals.length - 1 ? (
              <hr
                style={{
                  height: 1,
                  background: surface.hairline,
                  border: 0,
                  margin: '0 0 0 16px',
                }}
              />
            ) : null}
          </div>
        ))
      )}
    </section>
  )
}

function MealRow({ meal }: { meal: ServerMeal }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}>
      <span style={{ fontSize: 22, width: 30, flexShrink: 0, textAlign: 'center' }}>
        {meal.emoji ?? '🍽'}
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            font: '600 14.5px inherit',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {meal.foodName}
        </span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            font: '400 11px inherit',
            color: label.secondary,
          }}
        >
          <span
            style={{ font: '600 11px inherit', letterSpacing: 0.3, textTransform: 'uppercase' }}
          >
            {MEAL_RU[meal.meal] ?? meal.meal}
          </span>
          <span>·</span>
          {/* Rendered in the timezone where the meal was eaten. */}
          <span className="tnum" style={{ font: '500 11px inherit' }}>
            {formatLocalTime(meal.timestamp, meal.tzOffsetMin)}
          </span>
          <span>·</span>
          <MealMacro letter="Б" value={meal.protein} color={palette.protein[1]} />
          <MealMacro letter="У" value={meal.carbs} color={palette.carbs[1]} />
          <MealMacro letter="Ж" value={meal.fats} color={palette.fat[1]} />
        </span>
      </div>

      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <MacroPie
          protein={meal.protein}
          carbs={meal.carbs}
          fat={meal.fats}
          proteinColor={palette.protein[1]}
          carbsColor={palette.carbs[1]}
          fatColor={palette.fat[1]}
          size={24}
        />
        <span
          className="tnum"
          style={{
            font: '700 15px inherit',
            color: palette.calories[1],
            width: 48,
            textAlign: 'right',
          }}
        >
          {Math.round(meal.calories)}
        </span>
      </span>
    </div>
  )
}

function MealMacro({
  letter,
  value,
  color,
}: {
  letter: string
  value: number
  color: string
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
      <span style={{ font: '700 11px inherit', color }}>{letter}</span>
      <span className="tnum">{Math.round(value)}</span>
    </span>
  )
}
