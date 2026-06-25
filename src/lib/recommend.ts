// /chat/recommend engine. Given today's logged intake + the user's recent
// food history, produce ONE food-combination recommendation per achievable
// target color (green / light_green / yellow / orange). Deterministic — no
// LLM, no scoring beyond the spec's tie-breaker.
//
// The algorithm and every threshold come from the implementation spec
// (recommend_food_color_implementation_spec.md). The single source of truth
// for color decisions is classifyDietDay — this file generates candidate
// final-day macros and asks the classifier to label them.

import type { dailyGoals, meals } from '../db/schema.ts'
import { type DietDayColor, classifyDietDay } from './dietDayClassifier.ts'

type Meal = typeof meals.$inferSelect
type Goal = typeof dailyGoals.$inferSelect

export type Macros = {
  calories: number
  protein: number
  fat: number
  carbs: number
}

// One deduped food carried into combo generation. `id` is the most-recent
// meal row that produced this food (handy for displaying the emoji the user
// originally tagged it with, and as a stable ref the iOS card can carry).
export type CandidateFood = {
  id: string
  displayName: string
  emoji: string | null
  // Most-recent eaten timestamp; used only for the post-dedup recency cap.
  lastEatenAt: Date
  calories: number
  protein: number
  fat: number
  carbs: number
}

// Recommendation row that ends up in chat_messages.meta. The iOS client
// renders one card per row; currentColor travels on every row so a single
// card carries enough context to label "Можно попасть в green: …". Field
// names are camelCase to match the rest of the API surface (FoodSnapshot,
// GoalSnapshot, etc.) — the spec uses snake_case for prose convenience only.
export type RecommendationFood = {
  id: string
  displayName: string
  emoji: string | null
  calories: number
  protein: number
  fat: number
  carbs: number
}

export type Recommendation = {
  currentColor: DietDayColor
  color: DietDayColor
  foods: RecommendationFood[]
  addedMacros: Macros
  finalMacros: Macros
}

// Target colors are surfaced in this order per spec. red/blue/gray are never
// recommended — they describe failure modes, not aspirations.
const TARGET_COLORS: DietDayColor[] = ['green', 'light_green', 'yellow', 'orange']

const MAX_CANDIDATES = 100
const MAX_COMBO_SIZE = 3
// Departure from the v1 spec ("not rank multiple options inside the same
// color"): the chat surface now wants several variants per color so the user
// can pick a combo that fits their appetite/preferences. 3 is a sweet spot
// between choice and chat clutter (4 colors × 3 = up to 12 cards).
const MAX_VARIANTS_PER_COLOR = 3
// Two combos overlapping by more than this fraction of foods are considered
// near-duplicates and won't both be picked. Diversity is applied greedily on
// top of the distance-sorted list — best variant always lands first, then
// each subsequent slot requires a meaningfully different food set.
const MAX_OVERLAP_FRACTION = 0.5

export type RecommendationContext = {
  goal: Goal
  current: Macros
  foodHistory: Meal[]
}

export type EngineResult = {
  current_color: DietDayColor
  recommendations: Recommendation[]
}

export function generateRecommendations(ctx: RecommendationContext): EngineResult {
  const target: Macros = {
    calories: ctx.goal.calorieGoal,
    protein: ctx.goal.proteinGGoal,
    fat: ctx.goal.fatGGoal,
    carbs: ctx.goal.carbsGGoal,
  }

  const current_color = classify(ctx.current, target)

  // Spec's "already green" shortcut: do not suggest unnecessary eating.
  if (current_color === 'green') {
    return {
      current_color,
      recommendations: [emptyGreenRecommendation(ctx.current)],
    }
  }

  const candidates = buildCandidateFoods(ctx.foodHistory, target.calories)
  const combos = generateCombos(candidates)

  // Evaluate every combo once and bucket by color so we can pick the best
  // per target without re-scanning everything for each color. Each entry
  // carries its distance to target — lower = closer to ideal macros, which
  // is what drives the per-color ranking below.
  const buckets = new Map<DietDayColor, EvaluatedCombo[]>()
  for (const combo of combos) {
    const added = sumMacros(combo)
    const final: Macros = {
      calories: ctx.current.calories + added.calories,
      protein: ctx.current.protein + added.protein,
      fat: ctx.current.fat + added.fat,
      carbs: ctx.current.carbs + added.carbs,
    }
    const color = classify(final, target)
    const entry: EvaluatedCombo = {
      combo,
      added,
      final,
      distance: distanceToTarget(final, target),
    }
    const bucket = buckets.get(color)
    if (bucket) bucket.push(entry)
    else buckets.set(color, [entry])
  }

  const recommendations: Recommendation[] = []
  for (const color of TARGET_COLORS) {
    const bucket = buckets.get(color)
    if (!bucket || bucket.length === 0) continue
    const winners = pickTopVariants(bucket, MAX_VARIANTS_PER_COLOR)
    for (const winner of winners) {
      recommendations.push({
        currentColor: current_color,
        color,
        foods: winner.combo.map((f) => ({
          id: f.id,
          displayName: f.displayName,
          emoji: f.emoji,
          calories: f.calories,
          protein: f.protein,
          fat: f.fat,
          carbs: f.carbs,
        })),
        addedMacros: winner.added,
        finalMacros: winner.final,
      })
    }
  }

  return { current_color, recommendations }
}

type EvaluatedCombo = {
  combo: CandidateFood[]
  added: Macros
  final: Macros
  // Normalized L1 distance of `final` from `target` macros. The selection
  // step sorts by this — a green combo that lands 5 kcal over target beats
  // a green combo that lands 350 kcal under, even though both are "green".
  distance: number
}

function classify(actual: Macros, target: Macros): DietDayColor {
  return classifyDietDay({
    calorieGoal: target.calories,
    proteinGoal: target.protein,
    fatGoal: target.fat,
    carbGoal: target.carbs,
    calories: actual.calories,
    protein: actual.protein,
    fat: actual.fat,
    carbs: actual.carbs,
  })
}

// L1 distance of actual macros from target, normalized so each macro
// contributes a comparable share regardless of scale. Carbs participate only
// when a goal is defined for them — matches the classifier's "carbs are
// optional" stance.
function distanceToTarget(actual: Macros, target: Macros): number {
  let d = 0
  if (target.calories > 0) d += Math.abs(actual.calories - target.calories) / target.calories
  if (target.protein > 0) d += Math.abs(actual.protein - target.protein) / target.protein
  if (target.fat > 0) d += Math.abs(actual.fat - target.fat) / target.fat
  if (target.carbs > 0) d += Math.abs(actual.carbs - target.carbs) / target.carbs
  return d
}

// Most-recent-occurrence dedup (v1 simplification permitted by the spec). The
// key is the trimmed/lowercased/whitespace-collapsed food name — variations
// like "Греческий йогурт " vs "греческий  йогурт" collapse to one row.
function buildCandidateFoods(history: Meal[], targetCalories: number): CandidateFood[] {
  const byKey = new Map<string, CandidateFood>()
  for (const m of history) {
    if (!isValid(m)) continue
    // Optional spec filter: drop entries that alone would blow past the daily
    // calorie budget. Keeps the combo space sane and avoids absurd suggestions.
    if (m.calories > 1.2 * targetCalories) continue
    const key = normalizeName(m.foodName)
    if (!key) continue
    const existing = byKey.get(key)
    if (!existing || existing.lastEatenAt.getTime() < m.timestamp.getTime()) {
      byKey.set(key, {
        id: m.id,
        displayName: m.foodName,
        emoji: m.emoji,
        lastEatenAt: m.timestamp,
        calories: m.calories,
        protein: m.protein,
        fat: m.fats,
        carbs: m.carbs,
      })
    }
  }

  // Cap to MAX_CANDIDATES keeping the most recently eaten foods.
  const all = Array.from(byKey.values()).sort(
    (a, b) => b.lastEatenAt.getTime() - a.lastEatenAt.getTime(),
  )
  return all.slice(0, MAX_CANDIDATES)
}

function isValid(m: Meal): boolean {
  return (
    Number.isFinite(m.calories) &&
    Number.isFinite(m.protein) &&
    Number.isFinite(m.fats) &&
    m.calories >= 0 &&
    m.protein >= 0 &&
    m.fats >= 0
  )
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function generateCombos(foods: CandidateFood[]): CandidateFood[][] {
  const combos: CandidateFood[][] = [[]]
  for (let i = 0; i < foods.length; i++) {
    combos.push([foods[i]!])
  }
  for (let i = 0; i < foods.length; i++) {
    for (let j = i + 1; j < foods.length; j++) {
      combos.push([foods[i]!, foods[j]!])
    }
  }
  if (MAX_COMBO_SIZE >= 3) {
    for (let i = 0; i < foods.length; i++) {
      for (let j = i + 1; j < foods.length; j++) {
        for (let k = j + 1; k < foods.length; k++) {
          combos.push([foods[i]!, foods[j]!, foods[k]!])
        }
      }
    }
  }
  return combos
}

function sumMacros(combo: CandidateFood[]): Macros {
  const total: Macros = { calories: 0, protein: 0, fat: 0, carbs: 0 }
  for (const f of combo) {
    total.calories += f.calories
    total.protein += f.protein
    total.fat += f.fat
    total.carbs += f.carbs
  }
  return total
}

// Picks up to `limit` variants from a per-color bucket. Ranks by
// distance-to-target (closest macro fit wins), breaks ties with the spec's
// item_count → added_calories → lexical chain so identical inputs always
// produce the same ranking. A greedy diversity filter prevents the top
// picks from being near-duplicates that share most of their foods.
function pickTopVariants(
  entries: EvaluatedCombo[],
  limit: number,
): EvaluatedCombo[] {
  const sorted = entries.slice().sort(compareCombos)
  const picked: EvaluatedCombo[] = []
  for (const candidate of sorted) {
    if (picked.length >= limit) break
    if (picked.every((p) => isDiverseEnough(candidate, p))) {
      picked.push(candidate)
    }
  }
  // Fallback: if diversity filtering culled everything past the first pick
  // (small candidate space, e.g. 2 foods total), fall back to plain top-N
  // so the user still sees alternatives.
  if (picked.length < Math.min(limit, sorted.length)) {
    for (const candidate of sorted) {
      if (picked.length >= limit) break
      if (!picked.includes(candidate)) picked.push(candidate)
    }
  }
  return picked
}

function compareCombos(a: EvaluatedCombo, b: EvaluatedCombo): number {
  if (a.distance !== b.distance) return a.distance - b.distance
  if (a.combo.length !== b.combo.length) return a.combo.length - b.combo.length
  if (a.added.calories !== b.added.calories) return a.added.calories - b.added.calories
  return lexKey(a.combo).localeCompare(lexKey(b.combo))
}

// Two combos are "diverse enough" when they share at most
// MAX_OVERLAP_FRACTION of the foods in the smaller combo. The empty combo
// is trivially diverse from every non-empty combo (no overlap).
function isDiverseEnough(a: EvaluatedCombo, b: EvaluatedCombo): boolean {
  const minLen = Math.min(a.combo.length, b.combo.length)
  if (minLen === 0) return true
  const aIds = new Set(a.combo.map((f) => f.id))
  let overlap = 0
  for (const f of b.combo) {
    if (aIds.has(f.id)) overlap += 1
  }
  return overlap / minLen <= MAX_OVERLAP_FRACTION
}

function lexKey(combo: CandidateFood[]): string {
  return combo
    .map((f) => f.displayName.toLowerCase())
    .sort()
    .join('|')
}

function emptyGreenRecommendation(current: Macros): Recommendation {
  return {
    currentColor: 'green',
    color: 'green',
    foods: [],
    addedMacros: { calories: 0, protein: 0, fat: 0, carbs: 0 },
    finalMacros: { ...current },
  }
}
