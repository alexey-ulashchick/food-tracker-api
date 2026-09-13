import { deleteGoal, listGoals, syncTraining } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { Page } from '@/components/Page'
import { ScreenHeader } from '@/components/ScreenHeader'
import { ghostButtonStyle, iconButtonStyle } from '@/components/formStyles'
import { dayMonth, todayIso, weekdayLong } from '@/lib/dates'
import { useUi } from '@/store/ui'
import { MinusCircleIcon, Spinner, TrayIcon } from '@/theme/icons'
import {
  CHIP_BG_ALPHA,
  dayTypeTint,
  label,
  layout,
  radius,
  surface,
  systemBlue,
  withAlpha,
} from '@/theme/tokens'
import type { GoalBreakdown, ServerGoal } from '@shared/types.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

// Every day that has a goal, newest first, with where the number came from.
//
// The screen exists to make the override model visible. "A goal set in chat
// always beats the computed one" is a rule the app enforces in SQL; without
// somewhere to see which days are claimed by which, it is a rule you can only
// infer from numbers that refuse to change.

export function Goals() {
  const queryClient = useQueryClient()
  const setError = (err: unknown) =>
    useUi.getState().setError(err instanceof Error ? err.message : String(err))

  const query = useQuery({ queryKey: qk.goalsAll, queryFn: listGoals })

  const refreshAll = () => {
    for (const key of [['goals'], ['day-summary'], ['training-sync'], ['settings']]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }

  const remove = useMutation({
    mutationFn: (date: string) => deleteGoal(date),
    onSuccess: refreshAll,
    onError: setError,
  })

  const sync = useMutation({
    mutationFn: () => syncTraining(true),
    onSuccess: (result) => {
      refreshAll()
      if (!result.configured) {
        setError(new Error('Интеграция не настроена — заполни поля в Профиле.'))
      }
    },
    onError: setError,
  })

  const today = todayIso()
  const all = query.data ?? []

  // Today first, then forward. Newest-first put 4 October at the top and
  // buried today twenty cards down, which is backwards: the day you are
  // steering is today, and the days you can still change are the ones after
  // it. Past days are reference material, so they go behind a button rather
  // than above the fold.
  const upcoming = all.filter((g) => g.date >= today).sort((a, b) => a.date.localeCompare(b.date))
  // Descending, so the first past card is yesterday rather than six weeks ago.
  const past = all.filter((g) => g.date < today).sort((a, b) => b.date.localeCompare(a.date))

  // Nothing ahead means the plan has not been synced; the history is then all
  // there is to show, and hiding it behind a button would show nothing at all.
  const [pastOpen, setPastOpen] = useState(false)
  const showPast = pastOpen || upcoming.length === 0

  return (
    <Page>
      <ScreenHeader
        title="Цели"
        trailing={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {query.isFetching ? <Spinner /> : null}
            <button
              type="button"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              style={ghostButtonStyle}
            >
              {sync.isPending ? 'Обновляю…' : 'Обновить план'}
            </button>
          </span>
        }
      />

      {query.isLoading ? null : all.length === 0 ? (
        <Empty />
      ) : (
        <div className="settings-column">
          {upcoming.map((goal) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              today={today}
              busy={remove.isPending}
              onDelete={() => remove.mutate(goal.date)}
            />
          ))}

          {past.length === 0 ? null : showPast ? (
            <>
              {/* The dates run forward above and backward below, so the break
                  is labelled rather than left to be inferred from the numbers. */}
              <SectionLabel>Прошедшие дни</SectionLabel>
              {past.map((goal) => (
                <GoalRow
                  key={goal.id}
                  goal={goal}
                  today={today}
                  busy={remove.isPending}
                  onDelete={() => remove.mutate(goal.date)}
                />
              ))}
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPastOpen(true)}
              style={{ ...ghostButtonStyle, alignSelf: 'flex-start' }}
            >
              Прошедшие дни ({past.length})
            </button>
          )}
        </div>
      )}
    </Page>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontWeight: 600,
        fontSize: 'calc(12.5px * var(--type))',
        color: label.secondary,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        paddingLeft: 4,
        paddingTop: 6,
      }}
    >
      {children}
    </span>
  )
}

function GoalRow({
  goal,
  today,
  busy,
  onDelete,
}: {
  goal: ServerGoal
  today: string
  busy: boolean
  onDelete: () => void
}) {
  const manual = goal.source === 'manual'
  const tint = dayTypeTint[goal.dayType]

  return (
    <section
      style={{
        background: surface.card,
        borderRadius: radius.card,
        padding: layout.cardPadWide,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        // Today is the day the numbers are actually steering, so it gets a
        // hairline rather than a colour — the badges are already carrying
        // meaning and a third tint here would compete with them.
        outline: goal.date === today ? `1px solid ${surface.subtle}` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 'calc(15px * var(--type))' }}>
          {dayMonth(goal.date)}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'calc(12.5px * var(--type))',
            color: label.secondary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {weekdayLong(goal.date)}
        </span>
        <Badge tint={tint}>{goal.dayType === 'training' ? 'Тренировка' : 'Отдых'}</Badge>
        <Badge tint={manual ? systemBlue : label.secondary}>{manual ? 'Вручную' : 'Расчёт'}</Badge>
        {manual ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Удалить цель на ${dayMonth(goal.date)}`}
            style={iconButtonStyle}
          >
            <MinusCircleIcon size={16} />
          </button>
        ) : (
          // Keeps the numbers column aligned across rows of both kinds.
          <span style={{ width: 24 }} />
        )}
      </div>

      <div
        className="tnum"
        style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}
      >
        <span style={{ fontWeight: 600, fontSize: 'calc(17px * var(--type))' }}>
          {Math.round(goal.calorieGoal)} ккал
        </span>
        <span style={{ fontSize: 'calc(12.5px * var(--type))', color: label.secondary }}>
          Б {Math.round(goal.proteinGGoal)} · Ж {Math.round(goal.fatGGoal)} · У{' '}
          {Math.round(goal.carbsGGoal)}
        </span>
      </div>

      {goal.breakdown ? <Breakdown breakdown={goal.breakdown} /> : null}
    </section>
  )
}

/** Where an automatic number came from — base, gym, and one line per ride. */
function Breakdown({ breakdown }: { breakdown: GoalBreakdown }) {
  const parts = [`${Math.round(breakdown.base)} база`]
  if (breakdown.strength > 0) parts.push(`${Math.round(breakdown.strength)} силовая`)
  const rideKcal = breakdown.rides.reduce((sum, r) => sum + r.kcal, 0)
  if (rideKcal > 0) parts.push(`${Math.round(rideKcal)} вело`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span
        className="tnum"
        style={{ fontSize: 'calc(12.5px * var(--type))', color: label.secondary }}
      >
        {parts.join(' + ')}
      </span>

      {breakdown.rides.map((ride, i) => (
        <span
          // Two sessions can share a name; the index is what distinguishes
          // them, and the list is a frozen snapshot that never reorders.
          key={`${ride.name}-${i}`}
          className="tnum"
          style={{
            fontSize: 'calc(12px * var(--type))',
            color: label.tertiary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {ride.name} · {Math.round(ride.kj)} кДж · {KIND_LABEL[ride.kind]} ·{' '}
          {Math.round(ride.coeff * 100)}%
        </span>
      ))}

      {breakdown.carbsClamped ? (
        <span style={{ fontSize: 'calc(12px * var(--type))', color: label.tertiary }}>
          Белка и жиров больше, чем калорий — углеводы обнулены
        </span>
      ) : null}
    </div>
  )
}

const KIND_LABEL = {
  z2: 'Z2',
  threshold: 'SS/порог',
  vo2max: 'VO₂max',
  // Neither is worth an error banner, but they are different problems: one
  // means the session has no structured plan, the other that it has one in
  // watts and intervals.icu sent nothing to scale them against.
  unknown: 'без плана',
  needs_ftp: 'нет FTP',
} as const

function Badge({ tint, children }: { tint: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontWeight: 600,
        fontSize: 'calc(10.5px * var(--type))',
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        color: tint,
        background: withAlpha(tint, CHIP_BG_ALPHA),
        borderRadius: 999,
        padding: '3px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function Empty() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '40px 16px',
        color: label.secondary,
      }}
    >
      <TrayIcon size={22} />
      <span style={{ fontSize: 'calc(14px * var(--type))', textAlign: 'center' }}>
        Целей пока нет. Настрой тренировки в Профиле или попроси ассистента в чате.
      </span>
    </div>
  )
}
