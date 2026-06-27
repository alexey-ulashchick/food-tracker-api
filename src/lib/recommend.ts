// /chat/recommend engine. Given today's logged intake + the user's recent
// food history, propose food combinations that move the day closer to the
// user's macro targets. Deterministic — no LLM, ranked purely by how close
// each combo lands to the target K/P/C/F.
//
// Departures from the original v1 spec (recommend_food_color_implementation_spec.md):
//   - The spec was "one combo per achievable colour, four colours max".
//     We now surface up to MAX_VARIANTS combos ranked by macro fit so the
//     user can pick whichever appeals. Colour is preserved on each
//     recommendation as metadata for the UI badge but is no longer the
//     selection axis.
//   - To keep the deck diverse, any single food may appear in at most
//     MAX_USES_PER_FOOD of the surfaced recommendations. If "Греческий
//     йогурт" is the top pick three times running, the fourth combo that
//     would have used it is skipped in favour of something else.
//
// The single source of truth for colour decisions remains classifyDietDay
// — this file generates candidate final-day macros and asks the classifier
// to label them.

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

// Cap on unique candidate foods carried into combo generation. Was 100 in
// the original spec; on a 256MB fly.io VM with 100 candidates the
// resulting ~165k combos × ~250 bytes per EvaluatedCombo (plus sort
// temporaries) blew past the memory budget and the machine OOM-killed
// itself. 50 candidates → C(50,1)+C(50,2)+C(50,3) ≈ 21k combos, ~5MB
// for the evaluated array, room to spare. The user's most recently
// eaten foods are kept; older entries are dropped first.
const MAX_CANDIDATES = 50
const MAX_COMBO_SIZE = 3
// Number of recommendations to surface in chat. With 4 macros to fit and
// up to 100 candidate foods, 10 gives the user real choice without
// flooding the chat.
const MAX_VARIANTS = 10
// Across the MAX_VARIANTS surfaced combos, any single food appears in at
// most this many of them. Keeps the deck from collapsing into "everything
// is yogurt-based" when one food happens to fit the user's deficit
// perfectly.
const MAX_USES_PER_FOOD = 3

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

  // Evaluate every combo once. Colour is just metadata for the UI now —
  // ranking is purely by how close the resulting day macros land to the
  // user's K/P/C/F targets.
  const evaluated: EvaluatedCombo[] = []
  for (const combo of combos) {
    if (combo.length === 0) continue
    const added = sumMacros(combo)
    const final: Macros = {
      calories: ctx.current.calories + added.calories,
      protein: ctx.current.protein + added.protein,
      fat: ctx.current.fat + added.fat,
      carbs: ctx.current.carbs + added.carbs,
    }
    evaluated.push({
      combo,
      added,
      final,
      color: classify(final, target),
      distance: distanceToTarget(final, target),
    })
  }

  evaluated.sort(compareCombos)

  // Drop combos whose food set we've already seen at a better rank. The
  // generator should never produce two combos with the same food set, but
  // a defensive pass costs nothing and prevents user-visible duplicates if
  // anything upstream ever changes (e.g. allowing repetition within a
  // combo would let "1x A + 2x B" and "2x A + 1x B" both surface).
  const deduped = dedupByFoodSet(evaluated)

  const winners = pickTopVariantsWithFoodCap(deduped, MAX_VARIANTS, MAX_USES_PER_FOOD)

  const recommendations: Recommendation[] = winners.map((w) => ({
    currentColor: current_color,
    color: w.color,
    foods: w.combo.map((f) => ({
      id: f.id,
      displayName: f.displayName,
      emoji: f.emoji,
      calories: f.calories,
      protein: f.protein,
      fat: f.fat,
      carbs: f.carbs,
    })),
    addedMacros: w.added,
    finalMacros: w.final,
  }))

  return { current_color, recommendations }
}

type EvaluatedCombo = {
  combo: CandidateFood[]
  added: Macros
  final: Macros
  color: DietDayColor
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

// All combos of size 1..MAX_COMBO_SIZE with unique foods. No repetition
// inside a combo — "3 servings of yogurt" is not modelled because the
// spec treats a meal log entry as a complete dish, and across-deck
// diversity is enforced separately (see pickTopVariantsWithFoodCap).
function generateCombos(foods: CandidateFood[]): CandidateFood[][] {
  const combos: CandidateFood[][] = []
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

// Walks the distance-sorted list and grabs the best combos while making
// sure no single food appears in more than `maxUsesPerFood` of them. As
// each combo is picked, every food it contains gets its usage counter
// bumped; a combo whose foods are all already at the cap is skipped and
// the next best alternative is considered.
function pickTopVariantsWithFoodCap(
  entries: EvaluatedCombo[],
  limit: number,
  maxUsesPerFood: number,
): EvaluatedCombo[] {
  const picked: EvaluatedCombo[] = []
  const usageByFood = new Map<string, number>()
  for (const candidate of entries) {
    if (picked.length >= limit) break
    const wouldExceed = candidate.combo.some(
      (f) => (usageByFood.get(f.id) ?? 0) >= maxUsesPerFood,
    )
    if (wouldExceed) continue
    picked.push(candidate)
    for (const f of candidate.combo) {
      usageByFood.set(f.id, (usageByFood.get(f.id) ?? 0) + 1)
    }
  }
  return picked
}

// Drops combos whose canonical food-set key matches one already kept.
// Input is expected to be pre-sorted (best first), so the first occurrence
// wins and everything else with the same key is discarded.
function dedupByFoodSet(entries: EvaluatedCombo[]): EvaluatedCombo[] {
  const seen = new Set<string>()
  const out: EvaluatedCombo[] = []
  for (const e of entries) {
    const key = e.combo
      .map((f) => f.id)
      .sort()
      .join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

// Lower rank = better outcome. The target colours sort ahead of the
// failure colours, which would only appear in the deck if the candidate
// pool is so weak that nothing usable can be reached — we still rank them
// among themselves for determinism.
const COLOR_RANK: Record<DietDayColor, number> = {
  green: 0,
  light_green: 1,
  yellow: 2,
  orange: 3,
  blue: 4,
  red: 5,
  gray: 6,
}

// Sort key: colour tier first (a "Strong day" combo that's slightly off
// target beats a "Good day" combo that's bang-on; the user's mental model
// is "give me every green option before any light-green one"), then
// distance-to-target inside the colour, then the spec's chain
// (item_count → added_calories → lex) for deterministic tie-breaks.
function compareCombos(a: EvaluatedCombo, b: EvaluatedCombo): number {
  const ra = COLOR_RANK[a.color] ?? 99
  const rb = COLOR_RANK[b.color] ?? 99
  if (ra !== rb) return ra - rb
  if (a.distance !== b.distance) return a.distance - b.distance
  if (a.combo.length !== b.combo.length) return a.combo.length - b.combo.length
  if (a.added.calories !== b.added.calories) return a.added.calories - b.added.calories
  return lexKey(a.combo).localeCompare(lexKey(b.combo))
}

function lexKey(combo: CandidateFood[]): string {
  // Plain ASCII-lowercase sort — fast `<`/`>` on strings — instead of
  // localeCompare. compareCombos calls this on every tie-breaker step,
  // and the surrounding evaluator runs O(n*log n) comparisons over ~165k
  // combos. localeCompare through ICU is ~50µs per call on the fly.io
  // runtime, which adds up to tens of seconds of event-loop blocking and
  // misses the health check. Default Array.sort() with no comparator does
  // a fast UTF-16 code-unit sort, which is deterministic enough for a
  // tie-breaker key.
  const names: string[] = new Array(combo.length)
  for (let i = 0; i < combo.length; i++) {
    names[i] = combo[i]!.displayName.toLowerCase()
  }
  names.sort()
  return names.join('|')
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
