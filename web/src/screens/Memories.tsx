import { createMemory, deleteMemory, listMemories, updateMemory } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { ScreenHeader } from '@/components/ScreenHeader'
import { useUi } from '@/store/ui'
import { BrainIcon, MinusCircleIcon, PencilCircleIcon, Spinner, TrayIcon } from '@/theme/icons'
import { accent, label, layout, radius, surface, withAlpha } from '@/theme/tokens'
import type { ServerMemory } from '@shared/types.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

// Port of CalTracker/MemoriesView.swift.
//
// One fix along the way: the Swift version attached .swipeActions to an HStack
// inside a ScrollView rather than a List, which makes it a no-op — the menu was
// the only working delete path. Here the delete button is plainly visible.

const MAX_LENGTH = 500

export function Memories() {
  const queryClient = useQueryClient()
  const setError = useUi((s) => s.setError)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')

  const query = useQuery({ queryKey: qk.memories, queryFn: listMemories })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.memories })
  const onError = (err: unknown) => setError(err instanceof Error ? err.message : String(err))

  const create = useMutation({
    mutationFn: (content: string) => createMemory(content),
    onSuccess: () => {
      setDraft('')
      void invalidate()
    },
    onError,
  })
  const update = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => updateMemory(id, content),
    onSuccess: () => {
      setEditingId(null)
      void invalidate()
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteMemory(id),
    onSuccess: invalidate,
    onError,
  })

  const memories = query.data ?? []

  return (
    <div
      style={{
        padding: `${layout.screenTop}px ${layout.screenX}px ${layout.screenBottom}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: layout.cardGap,
      }}
    >
      <ScreenHeader title="Память" trailing={query.isFetching ? <Spinner /> : null} />

      <p style={{ fontWeight: 400, fontSize: 13, color: label.secondary, margin: 0 }}>
        Долгоживущие факты, которые ассистент учитывает в каждом ответе. Он добавляет их сам, когда
        ты говоришь «запомни», — но список можно править руками.
      </p>

      <section
        style={{
          background: surface.card,
          borderRadius: radius.card,
          padding: layout.cardPadWide,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontWeight: 600,
            fontSize: 11.5,
            color: '#BF5AF2',
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          <BrainIcon size={13} />
          Новый факт
        </span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_LENGTH))}
          rows={2}
          // Deliberately bilingual, as in the Swift original.
          placeholder={'напр. «Аллергия: лактоза» или «Любимый завтрак: овсянка»'}
          style={fieldStyle}
        />
        <button
          type="button"
          disabled={draft.trim().length === 0 || create.isPending}
          onClick={() => create.mutate(draft.trim())}
          style={primaryButtonStyle(draft.trim().length > 0 && !create.isPending)}
        >
          {create.isPending ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </section>

      {query.isLoading ? (
        <Card>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontWeight: 400,
              fontSize: 13,
              color: label.secondary,
            }}
          >
            <Spinner />
            Загружаю…
          </span>
        </Card>
      ) : memories.length === 0 ? (
        <Card>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontWeight: 400,
              fontSize: 13,
              color: label.secondary,
            }}
          >
            <TrayIcon size={15} />
            Пока ничего не сохранено
          </span>
        </Card>
      ) : (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {memories.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              editing={editingId === memory.id}
              draft={editingDraft}
              busy={update.isPending || remove.isPending}
              onBeginEdit={() => {
                setEditingId(memory.id)
                setEditingDraft(memory.content)
              }}
              onChangeDraft={setEditingDraft}
              onCancel={() => setEditingId(null)}
              onSave={() => update.mutate({ id: memory.id, content: editingDraft.trim() })}
              onDelete={() => remove.mutate(memory.id)}
            />
          ))}
        </section>
      )}
    </div>
  )
}

function MemoryRow({
  memory,
  editing,
  draft,
  busy,
  onBeginEdit,
  onChangeDraft,
  onCancel,
  onSave,
  onDelete,
}: {
  memory: ServerMemory
  editing: boolean
  draft: string
  busy: boolean
  onBeginEdit: () => void
  onChangeDraft: (v: string) => void
  onCancel: () => void
  onSave: () => void
  onDelete: () => void
}) {
  const unchanged = draft.trim() === memory.content || draft.trim().length === 0

  return (
    <div
      style={{
        background: surface.card,
        borderRadius: radius.actionCard,
        padding: '12px 14px',
        display: 'flex',
        alignItems: editing ? 'stretch' : 'center',
        gap: 10,
        flexDirection: editing ? 'column' : 'row',
      }}
    >
      {editing ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => onChangeDraft(e.target.value.slice(0, MAX_LENGTH))}
            rows={2}
            style={fieldStyle}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onCancel} style={ghostButtonStyle}>
              Отмена
            </button>
            <button
              type="button"
              disabled={unchanged || busy}
              onClick={onSave}
              style={primaryButtonStyle(!unchanged && !busy)}
            >
              Сохранить
            </button>
          </div>
        </>
      ) : (
        <>
          <span style={{ flex: 1, minWidth: 0, fontWeight: 400, fontSize: 14 }}>
            {memory.content}
          </span>
          <button type="button" onClick={onBeginEdit} aria-label="Изменить" style={iconButtonStyle}>
            <PencilCircleIcon size={16} />
          </button>
          <button type="button" onClick={onDelete} aria-label="Удалить" style={iconButtonStyle}>
            <MinusCircleIcon size={16} />
          </button>
        </>
      )}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: surface.card,
        borderRadius: radius.card,
        padding: layout.cardPadWide,
      }}
    >
      {children}
    </div>
  )
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'none',
  background: surface.input,
  border: 0,
  borderRadius: radius.field,
  color: label.primary,
  fontWeight: 400,
  fontSize: 14,
  padding: '10px 12px',
  lineHeight: 1.35,
}

const iconButtonStyle: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  color: label.secondary,
  padding: 4,
  cursor: 'pointer',
  display: 'flex',
  flexShrink: 0,
}

const ghostButtonStyle: React.CSSProperties = {
  border: 0,
  borderRadius: radius.field,
  background: surface.control,
  color: label.primary,
  fontWeight: 600,
  fontSize: 13,
  padding: '8px 12px',
  cursor: 'pointer',
}

function primaryButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    border: 0,
    borderRadius: radius.field,
    background: enabled ? accent : withAlpha('#8E8E93', 0.18),
    color: enabled ? '#000' : label.secondary,
    fontWeight: 600,
    fontSize: 13,
    padding: '8px 12px',
    cursor: enabled ? 'pointer' : 'default',
  }
}
