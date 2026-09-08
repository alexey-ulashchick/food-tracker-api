import { CHAT_HISTORY_LIMIT, getGoal, listChat, listMeals } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { CalorieMeter } from '@/components/CalorieMeter'
import { ChatBubble, TypingBubble } from '@/components/ChatBubble'
import { ScreenHeader } from '@/components/ScreenHeader'
import { FoodCard, GoalCard, MealUpdateCard, MemoryCard } from '@/components/cards/FoodCard'
import { RecommendationErrorCard, RecommendationStack } from '@/components/cards/RecommendationCard'
import { MacroRing } from '@/components/ring/MacroRing'
import type { ChatItem, TurnUsage } from '@/lib/chatMapper'
import { collectUsage, toChatItems } from '@/lib/chatMapper'
import { toRenderItems } from '@/lib/chatRenderItems'
import { renderCost } from '@/lib/costDisplay'
import { todayIso } from '@/lib/dates'
import { makeThumb } from '@/lib/thumbnail'
import { useUi } from '@/store/ui'
import {
  ArrowUpIcon,
  CloseCircleIcon,
  CopyIcon,
  PlusIcon,
  SparklesIcon,
  Spinner,
} from '@/theme/icons'
import { accent, label, layout, palette, radius, singleRingSpec, surface } from '@/theme/tokens'
import type { ServerGoal, ServerMeal } from '@shared/types.ts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isRecommendCommand, useChatStream } from './useChatStream'

// Port of CalTracker/ChatView.swift.
//
// The message list is deliberately NOT virtualised. The Swift version started
// with a LazyVStack and had to abandon it: lazy layout jumped the scroll
// position whenever the fixed-height recommendation deck moved between its
// estimated and measured heights. Sixty rows render eagerly for nothing.

const MACRO_LETTERS = { protein: 'Б', carbs: 'У', fat: 'Ж' } as const

export function Chat() {
  const queryClient = useQueryClient()
  const setError = useUi((s) => s.setError)
  const costDisplay = useUi((s) => s.costDisplay)
  const resetToToday = useUi((s) => s.resetToToday)
  const today = todayIso()

  // Landing on Chat snaps the macro strip back to the real today; otherwise it
  // keeps showing whatever past day Today was left on, and visibly disagrees
  // with the context the LLM was given.
  useEffect(() => {
    resetToToday()
  }, [resetToToday])

  const historyQuery = useQuery({
    queryKey: qk.chat(CHAT_HISTORY_LIMIT),
    queryFn: () => listChat(),
  })
  const goalQuery = useQuery({ queryKey: qk.goal(today), queryFn: () => getGoal(today) })
  const mealsQuery = useQuery({
    queryKey: qk.meals(today, today),
    queryFn: () => listMeals(today, today),
  })

  const stream = useChatStream({ onError: setError })

  const history = historyQuery.data ?? []
  const items = useMemo(() => {
    const serverItems = toChatItems(history)
    // Anything the turn already committed is in the server list after the
    // refetch, so drop duplicates by id.
    const seen = new Set(serverItems.map((i) => i.id))
    return [...serverItems, ...stream.live.filter((i) => !seen.has(i.id))]
  }, [history, stream.live])
  const usage: Record<string, TurnUsage> = { ...collectUsage(history), ...stream.usage }
  const renderItems = toRenderItems(items)

  const bottomRef = useRef<HTMLDivElement>(null)
  const lastCount = useRef(0)

  // Anchor to the newest message. useLayoutEffect so the move happens before
  // paint and the user never sees the jump. The count is tracked in a ref
  // rather than in the dependency list because `items` is rebuilt every render.
  useLayoutEffect(() => {
    if (items.length === lastCount.current) return
    lastCount.current = items.length
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [items])

  async function submit(text: string, attachment: { file: File; thumb: string } | null) {
    const trimmed = text.trim()
    if (!trimmed && !attachment) return

    // The command is intercepted here so a typo still reaches the LLM, which
    // can explain itself — same reasoning as AppState.send.
    const result = isRecommendCommand(trimmed)
      ? await stream.recommend()
      : // The server requires non-empty content, so a bare photo gets a caption.
        await stream.send(trimmed || '[photo]', attachment)

    await queryClient.invalidateQueries({ queryKey: ['chat'] })
    if (
      [...result.touched].some(
        (k) => k.startsWith('meal_') || k === 'goal_set' || k === 'recommend',
      )
    ) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['meals'] }),
        queryClient.invalidateQueries({ queryKey: ['goals'] }),
        queryClient.invalidateQueries({ queryKey: ['day-summary'] }),
      ])
    }
    if ([...result.touched].some((k) => k.startsWith('memory_'))) {
      await queryClient.invalidateQueries({ queryKey: qk.memories })
    }
    stream.reset()
  }

  return (
    // Chat owns its scrolling rather than riding the shell's pane: the header
    // and the macro strip are pinned and only the transcript moves, which is how
    // ChatView.swift is built — ScreenHeader sits outside the ScrollView, unlike
    // History and You where it scrolls away with the content.
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flexShrink: 0, padding: `${layout.screenTop}px ${layout.screenX}px 6px` }}>
        <ScreenHeader title="Чат" trailing={historyQuery.isFetching ? <Spinner /> : null} />
      </div>

      <MacroStrip goal={goalQuery.data ?? null} meals={mealsQuery.data ?? []} />

      <div
        className="chat-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px 12px' }}
      >
        {historyQuery.isLoading ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 10,
              paddingTop: 40,
              fontWeight: 400,
              fontSize: 13,
              color: label.secondary,
            }}
          >
            <Spinner />
            Загружаю переписку…
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {renderItems.map((entry) => (
            <div key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {entry.kind === 'single' ? (
                <>
                  <CostLabel text={renderCost(costDisplay, usage[entry.item.id])} />
                  <Row item={entry.item} />
                </>
              ) : (
                <RecommendationStack variants={entry.variants} />
              )}
            </div>
          ))}
        </div>
        <div ref={bottomRef} />
      </div>

      <Composer
        busy={stream.status.kind === 'busy'}
        onSubmit={submit}
        onRecommend={() => void submit('/recommend', null)}
      />
    </div>
  )
}

function CostLabel({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <span
      className="tnum"
      style={{ fontWeight: 500, fontSize: 10, color: label.secondary, paddingLeft: 6 }}
    >
      {text}
    </span>
  )
}

function Row({ item }: { item: ChatItem }) {
  const copy = copyText(item)

  const content = (() => {
    switch (item.kind) {
      case 'user':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            {item.thumb ? (
              <img
                src={item.thumb}
                alt=""
                style={{ maxWidth: 180, borderRadius: radius.field, display: 'block' }}
              />
            ) : null}
            <ChatBubble text={item.text} isUser />
          </div>
        )
      case 'ai':
        return <ChatBubble text={item.text} isUser={false} />
      case 'streaming':
        return <ChatBubble text={item.text} isUser={false} />
      case 'typing':
        return <TypingBubble />
      case 'toolStatus':
        return <ToolStatus name={item.name} status={item.status} />
      case 'mealAdded':
        return <FoodCard item={item.item} action="added" />
      case 'mealRemoved':
        return <FoodCard item={item.item} action="removed" />
      case 'mealUpdated':
        return <MealUpdateCard before={item.before} after={item.after} />
      case 'goalSet':
        return <GoalCard item={item.item} />
      case 'memoryAdded':
        return <MemoryCard content={item.content} action={{ kind: 'added' }} />
      case 'memoryUpdated':
        return <MemoryCard content={item.after} action={{ kind: 'updated', before: item.before }} />
      case 'memoryRemoved':
        return <MemoryCard content={item.content} action={{ kind: 'removed' }} />
      case 'recommendationError':
        return <RecommendationErrorCard message={item.message} />
      default:
        return null
    }
  })()

  if (!copy) return content
  return (
    <div style={{ position: 'relative' }} className="chat-row">
      {content}
      <button
        type="button"
        className="chat-copy"
        onClick={() => void navigator.clipboard?.writeText(copy)}
        aria-label="Копировать"
        style={{
          position: 'absolute',
          top: 2,
          right: 2,
          border: 0,
          background: surface.elevated,
          color: label.secondary,
          borderRadius: 999,
          padding: 5,
          cursor: 'pointer',
          display: 'flex',
        }}
      >
        <CopyIcon />
      </button>
    </div>
  )
}

const TOOL_RU: Record<string, string> = {
  add_meal: 'записываю',
  update_meal: 'правлю запись',
  delete_meal: 'удаляю запись',
  set_goal: 'выставляю цель',
  add_memory: 'запоминаю',
  update_memory: 'обновляю память',
  delete_memory: 'забываю',
  get_goal_for_day: 'смотрю цель',
  get_meals_for_day: 'смотрю день',
  list_meals: 'листаю историю',
}

function ToolStatus({ name, status }: { name: string; status: 'start' | 'ok' | 'error' }) {
  const verb = TOOL_RU[name] ?? name
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontWeight: 500,
        fontSize: 11.5,
        color: label.secondary,
        paddingLeft: 6,
      }}
    >
      {status === 'start' ? <Spinner size={10} /> : null}
      {status === 'error' ? '⚠︎ ' : null}
      {verb}
      {status === 'ok' ? ' — готово' : status === 'error' ? ' — не вышло' : '…'}
    </span>
  )
}

function MacroStrip({ goal, meals }: { goal: ServerGoal | null; meals: ServerMeal[] }) {
  const eaten = meals.reduce(
    (a, m) => ({
      calories: a.calories + m.calories,
      protein: a.protein + m.protein,
      carbs: a.carbs + m.carbs,
      fat: a.fat + m.fats,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  )
  const targets = {
    calories: goal?.calorieGoal ?? 2650,
    protein: goal?.proteinGGoal ?? 170,
    carbs: goal?.carbsGGoal ?? 330,
    fat: goal?.fatGGoal ?? 74,
  }
  const spec = singleRingSpec.chatStrip

  return (
    <div
      className="material-thin"
      style={{
        // A row of the chat column, not a sticky overlay: the transcript below
        // is the scroller now, so there is nothing for this to stick to.
        flexShrink: 0,
        zIndex: 5,
        padding: '10px 16px',
        borderBottom: `0.5px solid ${surface.hairline}`,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <CalorieMeter
          current={eaten.calories}
          goal={targets.calories}
          stops={palette.calories}
          size="small"
        />
      </div>
      {/* Three independent rings, as in the Swift strip — a nested stack at
          36px collapses the innermost ring below its own stroke width. */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {(['protein', 'carbs', 'fat'] as const).map((key) => (
          <div key={key} style={{ position: 'relative', width: spec.size, height: spec.size }}>
            <MacroRing
              value={targets[key] > 0 ? eaten[key] / targets[key] : 0}
              stops={palette[key]}
              size={spec.size}
              strokeWidth={spec.strokeWidth}
            />
            <span
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 9.5,
                color: label.secondary,
                pointerEvents: 'none',
              }}
            >
              {MACRO_LETTERS[key]}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Composer({
  busy,
  onSubmit,
  onRecommend,
}: {
  busy: boolean
  onSubmit: (text: string, attachment: { file: File; thumb: string } | null) => Promise<void>
  onRecommend: () => void
}) {
  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState<{ file: File; thumb: string } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const canSend = !busy && (text.trim().length > 0 || attachment !== null)

  async function pick(file: File | undefined) {
    if (!file) return
    setPreparing(true)
    try {
      setAttachment({ file, thumb: await makeThumb(file) })
    } finally {
      setPreparing(false)
    }
  }

  async function send() {
    if (!canSend) return
    const payload = { text, attachment }
    setText('')
    setAttachment(null)
    await onSubmit(payload.text, payload.attachment)
  }

  return (
    <div
      className="material-thin"
      style={{
        flexShrink: 0,
        padding: '8px 12px',
        borderTop: `0.5px solid ${surface.hairline}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {attachment ? (
        <div style={{ position: 'relative', alignSelf: 'flex-start' }}>
          <img
            src={attachment.thumb}
            alt=""
            style={{ height: 64, borderRadius: radius.field, display: 'block' }}
          />
          <button
            type="button"
            onClick={() => setAttachment(null)}
            aria-label="Убрать фото"
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              border: 0,
              background: 'transparent',
              color: label.primary,
              padding: 0,
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            <CloseCircleIcon />
          </button>
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        {/* The browser owns camera permission, so the whole AVCaptureDevice
            dance and its "open Settings" alert are simply gone. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <input
          ref={libraryRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void pick(e.target.files?.[0])}
        />

        <div style={{ position: 'relative', flexShrink: 0 }}>
          <RoundButton
            label="Прикрепить фото"
            onClick={() => setMenuOpen((v) => !v)}
            background={surface.control}
          >
            {preparing ? <Spinner size={14} /> : <PlusIcon />}
          </RoundButton>
          {menuOpen ? (
            <div
              style={{
                position: 'absolute',
                bottom: 40,
                left: 0,
                background: surface.elevated,
                borderRadius: radius.field,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                overflow: 'hidden',
                zIndex: 20,
                minWidth: 150,
              }}
            >
              <MenuItem
                label="Снять фото"
                onClick={() => {
                  setMenuOpen(false)
                  cameraRef.current?.click()
                }}
              />
              <MenuItem
                label="Из галереи"
                onClick={() => {
                  setMenuOpen(false)
                  libraryRef.current?.click()
                }}
              />
            </div>
          ) : null}
        </div>

        <RoundButton label="Рекомендация" onClick={onRecommend} background={surface.control}>
          <SparklesIcon />
        </RoundButton>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Расскажи, что ты съел…"
          rows={1}
          style={{
            flex: 1,
            minWidth: 0,
            resize: 'none',
            maxHeight: 96,
            background: surface.control,
            border: 0,
            borderRadius: 18,
            color: label.primary,
            fontWeight: 400,
            fontSize: 16,
            padding: '9px 14px',
            lineHeight: 1.3,
          }}
        />

        {/* Swift also drew a mic here, but nothing was wired to it — dropped. */}
        {canSend ? (
          <RoundButton label="Отправить" onClick={() => void send()} background={accent} dark>
            <ArrowUpIcon />
          </RoundButton>
        ) : null}
      </div>
    </div>
  )
}

function RoundButton({
  label: text,
  onClick,
  background,
  dark,
  children,
}: {
  label: string
  onClick: () => void
  background: string
  dark?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={text}
      style={{
        width: 32,
        height: 32,
        border: 0,
        borderRadius: 999,
        background,
        color: dark ? '#000' : label.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  )
}

function MenuItem({ label: text, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        border: 0,
        background: 'transparent',
        color: label.primary,
        fontWeight: 400,
        fontSize: 14,
        textAlign: 'left',
        padding: '10px 14px',
        cursor: 'pointer',
      }}
    >
      {text}
    </button>
  )
}

/** Clipboard text per row kind, mirroring the Swift context menu. */
function copyText(item: ChatItem): string | null {
  switch (item.kind) {
    case 'user':
    case 'ai':
      return item.text
    case 'mealAdded':
    case 'mealRemoved':
      return `${item.item.emoji} ${item.item.name} — ${item.item.kcal} ккал`
    case 'mealUpdated':
      return `${item.after.emoji} ${item.after.name}: ${item.before.kcal} → ${item.after.kcal} ккал`
    case 'goalSet':
      return `${item.item.date}: ${item.item.kcal} ккал · Б ${item.item.protein} У ${item.item.carbs} Ж ${item.item.fat}`
    case 'memoryAdded':
    case 'memoryRemoved':
      return item.content
    case 'memoryUpdated':
      return item.after
    default:
      return null
  }
}
