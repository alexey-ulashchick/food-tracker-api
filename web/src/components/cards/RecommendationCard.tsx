import { SealCheckIcon, WarnCircleIcon } from '@/theme/icons'
import { dietDayColor, label, radius, withAlpha } from '@/theme/tokens'
import { DIET_DAY_TITLES } from '@shared/dietDayTitles.ts'
import type { DietDayColor, RecommendationMeta } from '@shared/types.ts'
import { useState } from 'react'
import { ActionCard, Kcal, MacroChip, cardDivider } from './ActionCard'

// Ports of CalTracker/RecommendationCard.swift. One card per achievable diet-day
// colour: a tinted badge, the dishes from the user's own history that get them
// there, then the resulting day totals.

type Props = {
  item: RecommendationMeta
  /** Set inside the deck so short cards match the tallest one. */
  fill?: boolean
}

export function RecommendationCard({ item, fill }: Props) {
  const tint = dietDayColor[item.color]
  const noFood = item.foods.length === 0

  return (
    <ActionCard
      pad="roomy"
      borderColor={withAlpha(tint, 0.45)}
      minHeight={fill ? '100%' : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: tint, flexShrink: 0 }} />
        <span style={{ font: '600 11.5px inherit', color: tint }}>
          {DIET_DAY_TITLES[item.color]}
        </span>
        <span style={{ marginLeft: 'auto', font: '500 11px inherit', color: label.secondary }}>
          {/* An empty combo reads as a status, not a suggestion to eat. */}
          {noFood ? 'день уже сложился' : `+${Math.round(item.addedMacros.calories)} ккал`}
        </span>
      </div>

      {noFood ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: tint, display: 'flex' }}>
            <SealCheckIcon size={14} />
          </span>
          <span style={{ font: '400 13px inherit', color: label.secondary }}>
            Можно ничего не есть — день уже сложился.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {item.foods.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }}>{f.emoji ?? '🍽'}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span
                  style={{
                    font: '600 14px inherit',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {f.displayName}
                </span>
                <span style={{ display: 'flex', gap: 10 }}>
                  <MacroChip kind="protein" value={f.protein} />
                  <MacroChip kind="carbs" value={f.carbs} />
                  <MacroChip kind="fat" value={f.fat} />
                </span>
              </div>
              <span style={{ marginLeft: 'auto', paddingLeft: 6 }}>
                <Kcal value={f.calories} size={14} />
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Totals sit at the bottom even when the deck stretches the card. */}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <hr style={cardDivider} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              font: '600 10.5px inherit',
              color: label.secondary,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Итог дня
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <Kcal value={item.finalMacros.calories} size={13} suffix=" ккал" />
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <MacroChip kind="protein" value={item.finalMacros.protein} />
              <MacroChip kind="carbs" value={item.finalMacros.carbs} />
              <MacroChip kind="fat" value={item.finalMacros.fat} />
            </span>
          </div>
        </div>
      </div>
    </ActionCard>
  )
}

/** Shown when /chat/recommend refused because today has no goal yet. */
export function RecommendationErrorCard({ message }: { message: string }) {
  return (
    <ActionCard
      cornerRadius={radius.errorCard}
      background={withAlpha('#FF9500', 0.12)}
      borderColor={withAlpha('#FF9500', 0.4)}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ color: '#FF9500', display: 'flex', paddingTop: 1 }}>
          <WarnCircleIcon size={16} />
        </span>
        <span style={{ font: '400 13.5px inherit' }}>{message}</span>
      </div>
    </ActionCard>
  )
}

/**
 * Horizontal deck of variants.
 *
 * The SwiftUI original took six attempts to stop the card's drag gesture from
 * stealing vertical scrolls from the chat, and settled on a TabView with a
 * hand-tuned fixed height capped at 360pt — which clipped tall variants. CSS
 * scroll-snap needs neither: the browser hands vertical drags to the parent
 * scroller itself, and flex stretch equalises card heights to the tallest in
 * the set with no magic number and no clipping.
 */
export function RecommendationStack({ variants }: { variants: RecommendationMeta[] }) {
  const [index, setIndex] = useState(0)
  const current = variants[Math.min(index, variants.length - 1)]
  const tint = dietDayColor[(current?.color ?? 'gray') as DietDayColor]

  return (
    <div style={{ position: 'relative' }}>
      <div
        className="snap-deck"
        onScroll={(e) => {
          const el = e.currentTarget
          // Card width is the full track, so the page index is a plain ratio.
          const next = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
          if (next !== index) setIndex(next)
        }}
      >
        {variants.map((item, i) => (
          <div key={`${item.color}-${i}`} style={{ display: 'flex', paddingRight: 2 }}>
            <RecommendationCard item={item} fill />
          </div>
        ))}
      </div>

      {variants.length > 1 ? (
        <span
          className="tnum"
          style={{
            position: 'absolute',
            top: 8,
            // The card is capped at 300px, so pin the chip to that edge rather
            // than the (wider) scroll track.
            left: 300 - 12,
            transform: 'translateX(-100%)',
            font: '700 10.5px inherit',
            color: '#fff',
            background: withAlpha(tint, 0.85),
            borderRadius: 999,
            padding: '3px 8px',
            pointerEvents: 'none',
          }}
        >
          {Math.min(index, variants.length - 1) + 1} / {variants.length}
        </span>
      ) : null}
    </div>
  )
}
