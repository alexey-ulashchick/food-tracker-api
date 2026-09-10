import {
  ArrowRightIcon,
  BrainIcon,
  CheckCircleIcon,
  MinusCircleIcon,
  PencilCircleIcon,
  TargetIcon,
} from '@/theme/icons'
import { label, palette, systemBlue } from '@/theme/tokens'
import { ActionCard, Kcal, MacroChip, StatusBadge } from './ActionCard'

// Ports of the four action cards in CalTracker/FoodCard.swift. Labels are
// Russian; the underlying API values (meal type, dayType) stay English.

export type Food = {
  emoji: string
  name: string
  kcal: number
  protein: number
  carbs: number
  fat: number
}

export type Goal = {
  date: string
  dayType: string
  kcal: number
  protein: number
  carbs: number
  fat: number
}

const DAY_TYPE_RU: Record<string, string> = {
  training: 'тренировочный',
  rest: 'отдых',
}

export function FoodCard({ item, action }: { item: Food; action: 'added' | 'removed' }) {
  const removed = action === 'removed'
  return (
    <ActionCard>
      {removed ? (
        <StatusBadge icon={<MinusCircleIcon />} text="Удалено" color={label.secondary} />
      ) : (
        <StatusBadge icon={<CheckCircleIcon />} text="Добавлено" color="#34C759" />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 'calc(22px * var(--type))', opacity: removed ? 0.5 : 1 }}>
          {item.emoji}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 'calc(14.5px * var(--type))',
              textDecoration: removed ? 'line-through' : undefined,
              textDecorationColor: removed ? label.secondary : undefined,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {item.name}
          </span>
          <span style={{ display: 'flex', gap: 10 }}>
            <MacroChip kind="protein" value={item.protein} />
            <MacroChip kind="carbs" value={item.carbs} />
            <MacroChip kind="fat" value={item.fat} />
          </span>
        </div>

        <span style={{ marginLeft: 'auto', paddingLeft: 6 }}>
          <Kcal value={item.kcal} muted={removed} />
        </span>
      </div>
    </ActionCard>
  )
}

/**
 * Before/after view for an in-place edit. Fields that did not change render
 * greyed out so the user can see at a glance what was actually touched.
 */
export function MealUpdateCard({ before, after }: { before: Food; after: Food }) {
  return (
    <ActionCard>
      <StatusBadge icon={<PencilCircleIcon />} text="Изменено" color={systemBlue} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 'calc(22px * var(--type))' }}>{after.emoji}</span>
        <span style={{ fontWeight: 600, fontSize: 'calc(14.5px * var(--type))' }}>
          {after.name}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <DiffRow label="ккал" before={before.kcal} after={after.kcal} tint="calories" />
        <DiffRow label="Б" before={before.protein} after={after.protein} tint="protein" />
        <DiffRow label="У" before={before.carbs} after={after.carbs} tint="carbs" />
        <DiffRow label="Ж" before={before.fat} after={after.fat} tint="fat" />
      </div>
    </ActionCard>
  )
}

function DiffRow({
  label: text,
  before,
  after,
  tint,
}: {
  label: string
  before: number
  after: number
  tint: 'calories' | 'protein' | 'carbs' | 'fat'
}) {
  const changed = Math.round(before) !== Math.round(after)
  const tintColor = {
    calories: palette.calories[1],
    protein: palette.protein[1],
    carbs: palette.carbs[1],
    fat: palette.fat[1],
  }[tint]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          fontWeight: 700,
          fontSize: 'calc(11.5px * var(--type))',
          color: tintColor,
          width: 28,
        }}
      >
        {text}
      </span>
      <span
        className="tnum"
        style={{
          fontWeight: 400,
          fontSize: 'calc(11.5px * var(--type))',
          color: label.secondary,
          textDecoration: changed ? 'line-through' : undefined,
        }}
      >
        {Math.round(before)}
      </span>
      <span style={{ color: label.secondary, display: 'flex' }}>
        <ArrowRightIcon />
      </span>
      <span
        className="tnum"
        style={{
          fontWeight: changed ? 600 : 400,
          fontSize: 'calc(11.5px * var(--type))',
          color: changed ? label.primary : label.secondary,
        }}
      >
        {Math.round(after)}
      </span>
    </div>
  )
}

export function GoalCard({ item }: { item: Goal }) {
  return (
    <ActionCard pad="even">
      <StatusBadge icon={<TargetIcon />} text="Цель установлена" color="#FF9500" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 'calc(12px * var(--type))',
            color: label.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {item.date}
        </span>
        <span className="tnum" style={{ fontWeight: 600, fontSize: 'calc(14.5px * var(--type))' }}>
          {Math.round(item.kcal)} ккал · {DAY_TYPE_RU[item.dayType] ?? item.dayType}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 14 }}>
        <MacroChip kind="protein" value={item.protein} unit="г" />
        <MacroChip kind="carbs" value={item.carbs} unit="г" />
        <MacroChip kind="fat" value={item.fat} unit="г" />
      </div>
    </ActionCard>
  )
}

export type MemoryAction =
  | { kind: 'added' }
  | { kind: 'updated'; before: string }
  | { kind: 'removed' }

export function MemoryCard({ content, action }: { content: string; action: MemoryAction }) {
  const removed = action.kind === 'removed'
  return (
    <ActionCard>
      {action.kind === 'added' ? (
        <StatusBadge icon={<BrainIcon />} text="Запомнил" color="#BF5AF2" />
      ) : action.kind === 'updated' ? (
        <StatusBadge icon={<PencilCircleIcon />} text="Память обновлена" color={systemBlue} />
      ) : (
        <StatusBadge icon={<MinusCircleIcon />} text="Забыл" color={label.secondary} />
      )}

      {action.kind === 'updated' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontWeight: 400,
              fontSize: 'calc(13px * var(--type))',
              color: label.secondary,
              textDecoration: 'line-through',
            }}
          >
            {action.before}
          </span>
          <span style={{ fontWeight: 600, fontSize: 'calc(14px * var(--type))' }}>{content}</span>
        </div>
      ) : (
        <span
          style={{
            fontWeight: 600,
            fontSize: 'calc(14px * var(--type))',
            color: removed ? label.secondary : label.primary,
            textDecoration: removed ? 'line-through' : undefined,
          }}
        >
          {content}
        </span>
      )}
    </ActionCard>
  )
}
