import { getSettings, syncTraining, updateSettings } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { Page } from '@/components/Page'
import { ScreenHeader } from '@/components/ScreenHeader'
import { fieldStyle, ghostButtonStyle, primaryButtonStyle } from '@/components/formStyles'
import { useUi } from '@/store/ui'
import { Spinner } from '@/theme/icons'
import { danger, label, layout, radius, surface } from '@/theme/tokens'
import {
  DEFAULT_TUNING,
  type GoalTuning,
  TUNING_GROUPS,
  type TuningField,
  type TuningUnit,
  rideCoefficient,
  tuningOrderError,
} from '@shared/goalTuning.ts'
import type { RideKind } from '@shared/types.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

// The dials behind an automatic goal, and what they would do.
//
// A separate screen rather than another block on Профиль: twelve numeric fields
// is a form, and it sits next to a preview that has to be read alongside them.
// The numbers and their bounds come from shared/goalTuning.ts, which the server
// validates against — so this form cannot offer a value the server will reject,
// and a dial added there appears here without an edit.

const SUFFIX: Record<TuningUnit, string> = {
  ratio: '%',
  kcal: 'ккал',
  minutes: 'мин',
  seconds: 'с',
}

/** Ratios are stored as fractions and read as percentages. */
function toDisplay(unit: TuningUnit, value: number): string {
  return unit === 'ratio' ? String(Math.round(value * 1000) / 10) : String(value)
}

function fromDisplay(unit: TuningUnit, raw: string): number {
  const n = Number(raw.trim().replace(',', '.'))
  return unit === 'ratio' ? n / 100 : n
}

/**
 * Sessions the preview scores.
 *
 * The work is not written down — it is computed from the athlete's own FTP,
 * because a ride's size is FTP × time × how hard it was ridden. Fixed
 * kilojoules would price the coefficients for somebody else.
 *
 * `intensity` is the whole session's average, not the interval target: a
 * VO2max hour spends most of itself recovering, which is why its average sits
 * near 0.75 rather than near 1.1.
 */
const EXAMPLES: ReadonlyArray<{
  name: string
  kind: RideKind
  minutes: number
  intensity: number
}> = [
  { name: 'Z2, 1 ч', kind: 'z2', minutes: 60, intensity: 0.65 },
  { name: 'Z2, 2 ч', kind: 'z2', minutes: 120, intensity: 0.65 },
  { name: 'Z2, 4 ч', kind: 'z2', minutes: 240, intensity: 0.6 },
  { name: 'SS / порог, 1 ч 15', kind: 'threshold', minutes: 75, intensity: 0.8 },
  { name: 'VO₂max, 1 ч', kind: 'vo2max', minutes: 60, intensity: 0.75 },
  // 90 minutes rather than 120: at the fallback coefficient a two-hour example
  // prints the same figure as the Z2 row above once the short band is widened,
  // and two identical numbers in a preview are a preview you cannot read.
  { name: 'Тип не определён, 1 ч 30', kind: 'unknown', minutes: 90, intensity: 0.65 },
]

/**
 * Used only until the first sync records the real one.
 *
 * Labelled as a stand-in wherever it is shown, because the whole point of the
 * preview is that the numbers are the athlete's own.
 */
const FALLBACK_FTP = 250

/** Planned mechanical work, kJ: watts × seconds / 1000. */
function exampleKj(minutes: number, intensity: number, ftp: number): number {
  return Math.round((intensity * ftp * minutes * 60) / 1000)
}

export function GoalTuningScreen() {
  const queryClient = useQueryClient()
  const setError = useUi((s) => s.setError)

  const query = useQuery({ queryKey: qk.settings, queryFn: getSettings })
  const saved = query.data?.goalTuning ?? DEFAULT_TUNING

  // Sparse and keyed, like the profile card's: a copy seeded on load would need
  // re-seeding on every window-focus refetch, which is exactly when someone is
  // halfway through typing a number.
  const [edits, setEdits] = useState<Partial<Record<keyof GoalTuning, string>>>({})

  const shown = (field: TuningField): string =>
    edits[field.key] ?? toDisplay(field.unit, saved[field.key])

  /** The tuning as the form currently reads, for the preview and for saving. */
  const draft: GoalTuning = { ...saved }
  const invalid: TuningField[] = []
  for (const group of TUNING_GROUPS) {
    for (const field of group.fields) {
      if (edits[field.key] === undefined) continue
      const value = fromDisplay(field.unit, edits[field.key] ?? '')
      if (!Number.isFinite(value) || value < field.min || value > field.max) {
        invalid.push(field)
        continue
      }
      draft[field.key] = value
    }
  }

  const orderError = tuningOrderError(draft)
  const dirty = Object.keys(edits).length > 0
  const canSave = dirty && invalid.length === 0 && orderError === null

  const save = useMutation({
    mutationFn: (tuning: GoalTuning | null) => updateSettings({ goalTuning: tuning }),
    onSuccess: () => {
      setEdits({})
      void queryClient.invalidateQueries({ queryKey: qk.settings })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  // Saving changes what every automatic goal should be, but the goals already
  // in the database were computed with the old numbers. Re-syncing is the step
  // that makes the screen's numbers true, so it happens here rather than being
  // left to the next background pass.
  const resync = useMutation({
    mutationFn: () => syncTraining(true),
    onSuccess: () => {
      for (const key of [['goals'], ['day-summary'], ['training-sync'], ['settings']]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const atDefaults = TUNING_GROUPS.every((g) =>
    g.fields.every((f) => saved[f.key] === DEFAULT_TUNING[f.key]),
  )

  return (
    <Page>
      <ScreenHeader
        title="Расчёт цели"
        subtitle="Во что превращается запланированная работа"
        trailing={query.isFetching || save.isPending || resync.isPending ? <Spinner /> : null}
      />

      <div className="settings-column">
        <Preview tuning={draft} ftp={query.data?.intervalsFtp ?? null} />

        {TUNING_GROUPS.map((group) => (
          <div className="card-block" key={group.title}>
            <SectionLabel>{group.title}</SectionLabel>
            <Card>
              {group.fields.map((field, i) => (
                <div key={field.key}>
                  <Field
                    field={field}
                    value={shown(field)}
                    invalid={invalid.includes(field)}
                    onChange={(raw) => setEdits((prev) => ({ ...prev, [field.key]: raw }))}
                  />
                  {i < group.fields.length - 1 ? <Divider /> : null}
                </div>
              ))}
            </Card>
          </div>
        ))}

        {orderError ? <Note>{orderError}</Note> : null}
        {invalid.length > 0 ? (
          <Note>Вне допустимых границ: {invalid.map((f) => f.label.toLowerCase()).join(', ')}</Note>
        ) : null}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => save.mutate(draft)}
            disabled={!canSave || save.isPending}
            style={primaryButtonStyle(canSave && !save.isPending)}
          >
            {save.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>

          {dirty ? (
            <button type="button" onClick={() => setEdits({})} style={ghostButtonStyle}>
              Отменить правки
            </button>
          ) : null}

          {atDefaults ? null : (
            <button
              type="button"
              onClick={() => {
                setEdits({})
                save.mutate(null)
              }}
              style={ghostButtonStyle}
            >
              Вернуть по умолчанию
            </button>
          )}

          <button
            type="button"
            onClick={() => resync.mutate()}
            disabled={resync.isPending}
            style={ghostButtonStyle}
          >
            {resync.isPending ? 'Пересчитываю…' : 'Пересчитать цели'}
          </button>
        </div>

        <Note muted>
          Сохранение меняет только правила. Цели, уже посчитанные старыми числами, останутся
          прежними, пока не нажать «Пересчитать цели» — и прошедшие дни не пересчитываются никогда.
        </Note>
      </div>
    </Page>
  )
}

/** What the current numbers would do to a fixed amount of work. */
function Preview({ tuning, ftp }: { tuning: GoalTuning; ftp: number | null }) {
  const effective = ftp ?? FALLBACK_FTP

  return (
    <div className="card-block">
      <SectionLabel>
        {ftp === null
          ? `Что получится · FTP не определён, примеры при ${FALLBACK_FTP} Вт`
          : `Что получится · при FTP ${Math.round(ftp)} Вт`}
      </SectionLabel>
      <Card>
        {EXAMPLES.map((example, i) => {
          const coeff = rideCoefficient(example.kind, example.minutes, tuning)
          const kj = exampleKj(example.minutes, example.intensity, effective)
          return (
            <div key={example.name}>
              <div
                style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 14px' }}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 'calc(13.5px * var(--type))' }}>
                  {example.name}
                </span>
                <span
                  className="tnum"
                  style={{ fontSize: 'calc(12px * var(--type))', color: label.tertiary }}
                >
                  {kj} кДж × {Math.round(coeff * 100)}%
                </span>
                <span
                  className="tnum"
                  style={{
                    fontWeight: 700,
                    fontSize: 'calc(14px * var(--type))',
                    width: 74,
                    textAlign: 'right',
                  }}
                >
                  {Math.round(kj * coeff)} ккал
                </span>
              </div>
              <Divider />
            </div>
          )
        })}

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 14px' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 'calc(13.5px * var(--type))' }}>
            Силовая
          </span>
          <span
            className="tnum"
            style={{ fontSize: 'calc(12px * var(--type))', color: label.tertiary }}
          >
            фиксировано
          </span>
          <span
            className="tnum"
            style={{
              fontWeight: 700,
              fontSize: 'calc(14px * var(--type))',
              width: 74,
              textAlign: 'right',
            }}
          >
            {Math.round(tuning.strengthKcal)} ккал
          </span>
        </div>
      </Card>
    </div>
  )
}

function Field({
  field,
  value,
  invalid,
  onChange,
}: {
  field: TuningField
  value: string
  invalid: boolean
  onChange: (raw: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 'calc(14px * var(--type))' }}>{field.label}</span>
        {field.hint ? (
          <span style={{ fontSize: 'calc(11.5px * var(--type))', color: label.tertiary }}>
            {field.hint}
          </span>
        ) : null}
      </span>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        aria-label={field.label}
        aria-invalid={invalid}
        style={{
          ...fieldStyle,
          width: 76,
          textAlign: 'right',
          color: invalid ? danger : label.primary,
        }}
      />
      <span style={{ width: 34, fontSize: 'calc(12px * var(--type))', color: label.secondary }}>
        {SUFFIX[field.unit]}
      </span>
    </div>
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
      }}
    >
      {children}
    </span>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section style={{ background: surface.card, borderRadius: radius.card, paddingBottom: 4 }}>
      {children}
    </section>
  )
}

function Divider() {
  return (
    <hr
      style={{
        height: 1,
        background: surface.hairline,
        border: 0,
        margin: `0 0 0 ${layout.cardPad}px`,
      }}
    />
  )
}

function Note({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      style={{
        fontSize: 'calc(12px * var(--type))',
        color: muted ? label.tertiary : danger,
        paddingLeft: 4,
      }}
    >
      {children}
    </span>
  )
}
