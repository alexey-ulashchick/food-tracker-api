import { getSettings, syncTraining, updateSettings } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { fieldStyle, ghostButtonStyle, primaryButtonStyle } from '@/components/formStyles'
import { useUi } from '@/store/ui'
import { FlameIcon, Spinner } from '@/theme/icons'
import { danger, label, positive, radius, surface, withAlpha } from '@/theme/tokens'
import type { ServerSettings, TrainingSetupField } from '@shared/types.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

// The training integration: the base expenditure and fixed macros an automatic
// goal is built from, plus the intervals.icu credentials the plan is fetched
// with. Lives on Профиль, alongside the other settings.

/** Fields the card edits as plain numbers. */
const NUMBERS = [
  { key: 'baseCalories', title: 'Базовый расход', unit: 'ккал' },
  { key: 'proteinG', title: 'Белок', unit: 'г' },
  { key: 'fatG', title: 'Жиры', unit: 'г' },
] as const

type NumberKey = (typeof NUMBERS)[number]['key']
type EditKey = NumberKey | 'intervalsAthleteId'

const MISSING_LABEL: Record<TrainingSetupField, string> = {
  baseCalories: 'базовый расход',
  proteinG: 'белок',
  fatG: 'жиры',
  intervalsAthleteId: 'ID атлета',
  intervalsApiKey: 'API-ключ',
}

export function TrainingSettingsCard() {
  const queryClient = useQueryClient()
  const setError = useUiError()

  const query = useQuery({ queryKey: qk.settings, queryFn: getSettings })
  const settings = query.data ?? null

  // Drafts are keyed and sparse rather than a copy of the row seeded on load.
  // A copy would have to be re-seeded whenever a refetch lands, and a refetch
  // lands on every window focus — which is exactly when someone is halfway
  // through typing. An absent key simply means "show what the server has".
  const [edits, setEdits] = useState<Partial<Record<EditKey, string>>>({})
  const [keyDraft, setKeyDraft] = useState<string | null>(null)

  const dirty = Object.keys(edits).length > 0

  const shown = (key: EditKey): string => {
    const draft = edits[key]
    if (draft !== undefined) return draft
    const value = settings?.[key]
    return value === null || value === undefined ? '' : String(value)
  }

  const save = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      setEdits({})
      setKeyDraft(null)
      void queryClient.invalidateQueries({ queryKey: qk.settings })
      // The numbers feed every automatic goal, so they are stale the moment
      // these change.
      void queryClient.invalidateQueries({ queryKey: qk.trainingSync })
    },
    onError: setError,
  })

  const sync = useMutation({
    mutationFn: () => syncTraining(true),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: qk.settings })
      for (const key of [['goals'], ['day-summary'], ['training-sync']]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
      if (!result.configured) {
        setError(new Error(`Не хватает: ${result.missing.map((m) => MISSING_LABEL[m]).join(', ')}`))
      }
    },
    onError: setError,
  })

  const invalid = NUMBERS.filter(({ key }) => {
    const raw = edits[key]
    return raw !== undefined && raw.trim() !== '' && !Number.isFinite(Number(raw))
  })

  function commit() {
    const patch: Record<string, number | string | null> = {}
    for (const key of Object.keys(edits) as EditKey[]) {
      const raw = (edits[key] ?? '').trim()
      if (key === 'intervalsAthleteId') patch[key] = raw === '' ? null : raw
      else patch[key] = raw === '' ? null : Number(raw)
    }
    if (keyDraft !== null && keyDraft.trim() !== '') patch.intervalsApiKey = keyDraft.trim()
    save.mutate(patch)
  }

  const busy = save.isPending || sync.isPending
  const canSave = (dirty || (keyDraft !== null && keyDraft.trim() !== '')) && invalid.length === 0

  return (
    <section style={{ background: surface.card, borderRadius: radius.card }}>
      <Header fetching={query.isFetching || busy} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 14px 14px' }}>
        {NUMBERS.map(({ key, title, unit }) => (
          <FieldRow key={key} title={title} unit={unit}>
            <input
              value={shown(key)}
              onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
              inputMode="decimal"
              placeholder="—"
              style={{ ...fieldStyle, textAlign: 'right', width: 96 }}
            />
          </FieldRow>
        ))}

        <Divider />

        <FieldRow title="ID атлета">
          <input
            value={shown('intervalsAthleteId')}
            onChange={(e) => setEdits((prev) => ({ ...prev, intervalsAthleteId: e.target.value }))}
            placeholder="i123456"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ ...fieldStyle, textAlign: 'right', width: 140 }}
          />
        </FieldRow>

        <ApiKeyRow
          hint={settings?.intervalsKeyHint ?? null}
          draft={keyDraft}
          onDraft={setKeyDraft}
          onClear={() => save.mutate({ intervalsApiKey: null })}
        />

        {invalid.length > 0 ? (
          <Note tone="danger">
            Не число: {invalid.map((f) => f.title.toLowerCase()).join(', ')}
          </Note>
        ) : null}

        {canSave ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={commit}
              disabled={save.isPending}
              style={primaryButtonStyle(!save.isPending)}
            >
              {save.isPending ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        ) : null}

        <Divider />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <SyncStatus settings={settings} loading={query.isLoading} />
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            style={ghostButtonStyle}
          >
            {sync.isPending ? 'Обновляю…' : 'Обновить план'}
          </button>
        </div>
      </div>
    </section>
  )
}

function Header({ fetching }: { fetching: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}>
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: radius.iconTile,
          background: withAlpha(positive, 0.18),
          color: positive,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <FlameIcon size={15} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{ fontWeight: 400, fontSize: 'calc(16px * var(--type))' }}>Тренировки</span>
        <span
          style={{
            fontWeight: 400,
            fontSize: 'calc(12.5px * var(--type))',
            color: label.secondary,
          }}
        >
          Цель на день считается из базы и плана
        </span>
      </span>
      {fetching ? <Spinner /> : null}
    </div>
  )
}

function FieldRow({
  title,
  unit,
  children,
}: {
  title: string
  unit?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 'calc(14px * var(--type))' }}>{title}</span>
      {children}
      {unit ? (
        <span
          style={{
            width: 34,
            fontSize: 'calc(12.5px * var(--type))',
            color: label.secondary,
          }}
        >
          {unit}
        </span>
      ) : (
        <span style={{ width: 34 }} />
      )}
    </div>
  )
}

/**
 * The key goes in but never comes back, so this is not an editable field —
 * it is a hint plus a way to replace or remove what is behind it.
 */
function ApiKeyRow({
  hint,
  draft,
  onDraft,
  onClear,
}: {
  hint: string | null
  draft: string | null
  onDraft: (v: string | null) => void
  onClear: () => void
}) {
  if (draft !== null) {
    return (
      <FieldRow title="API-ключ">
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          type="password"
          placeholder="вставь ключ"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          style={{ ...fieldStyle, width: 140, font: '400 12px ui-monospace, monospace' }}
        />
      </FieldRow>
    )
  }

  return (
    <FieldRow title="API-ключ">
      <span
        className="tnum"
        style={{
          fontSize: 'calc(13px * var(--type))',
          color: hint ? label.primary : label.tertiary,
        }}
      >
        {hint ? `…${hint}` : 'не задан'}
      </span>
      <button type="button" onClick={() => onDraft('')} style={ghostButtonStyle}>
        {hint ? 'Заменить' : 'Задать'}
      </button>
      {hint ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Удалить ключ"
          style={{ ...ghostButtonStyle, background: withAlpha(danger, 0.16), color: danger }}
        >
          Удалить
        </button>
      ) : null}
    </FieldRow>
  )
}

function SyncStatus({
  settings,
  loading,
}: {
  settings: ServerSettings | null
  loading: boolean
}) {
  const text = loading
    ? 'Загружаю…'
    : settings?.intervalsSyncedAt
      ? `План обновлён ${formatSyncedAt(settings.intervalsSyncedAt)}`
      : 'План ещё не загружался'

  return (
    <span
      style={{
        fontSize: 'calc(12.5px * var(--type))',
        color: label.secondary,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  )
}

function Note({ tone, children }: { tone: 'danger'; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 'calc(12.5px * var(--type))',
        color: tone === 'danger' ? danger : label.secondary,
      }}
    >
      {children}
    </span>
  )
}

function Divider() {
  return <hr style={{ border: 0, borderTop: `0.5px solid ${surface.hairline}`, margin: 0 }} />
}

const TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** "в 14:32" today, "12 сент. 14:32" before that. */
function formatSyncedAt(iso: string): string {
  const at = new Date(iso)
  const sameDay = at.toDateString() === new Date().toDateString()
  return sameDay ? `в ${TIME.format(at)}` : DATE_TIME.format(at)
}

/** The shell's error banner, as a plain callback. */
function useUiError() {
  const setError = useUi((s) => s.setError)
  return (err: unknown) => setError(err instanceof Error ? err.message : String(err))
}
