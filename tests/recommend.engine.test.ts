import { describe, expect, test } from 'bun:test'
import type { dailyGoals, meals } from '../src/db/schema.ts'
import { generateRecommendations } from '../src/lib/recommend.ts'

type Goal = typeof dailyGoals.$inferSelect
type Meal = typeof meals.$inferSelect

// Stable target used across cases: 2000 kcal, 150 P, 60 F, 200 C.
// Mirrors the classifier thresholds we exercise (green needs k ≤ 1.03K, p ≥
// 0.90P, f ≥ 0.50F, carbs within ±30%).
const goal: Goal = {
  id: 'g',
  userId: 'u',
  dayType: 'rest',
  date: '2026-06-25',
  calorieGoal: 2000,
  proteinGGoal: 150,
  carbsGGoal: 200,
  fatGGoal: 60,
  updatedAt: new Date(),
}

let mealCounter = 0
function makeMeal(p: {
  foodName: string
  calories: number
  protein: number
  fats: number
  carbs: number
  daysAgo?: number
}): Meal {
  mealCounter += 1
  return {
    id: `m-${mealCounter}`,
    userId: 'u',
    timestamp: new Date(Date.now() - (p.daysAgo ?? 0) * 86_400_000),
    tzOffsetMin: 0,
    meal: 'Lunch',
    emoji: null,
    foodName: p.foodName,
    calories: p.calories,
    protein: p.protein,
    carbs: p.carbs,
    fats: p.fats,
    updatedAt: new Date(),
  }
}

describe('generateRecommendations', () => {
  test('returns one recommendation per achievable color in canonical order', () => {
    // current = yellow (protein at 80% of goal → severity 1).
    const current = { calories: 1500, protein: 120, fat: 30, carbs: 150 }

    // Picks a food set where green/light_green/yellow are reachable but
    // orange is not: every food keeps the calorie total under +5% over goal,
    // so the worst we can produce is yellow severity 1.
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [
        // Lands the day in green: bumps protein to ≥135, fat to ≥30, calories
        // around 1900, carbs around 200.
        makeMeal({ foodName: 'Protein boost', calories: 400, protein: 25, fats: 30, carbs: 50 }),
        // Lands the day in light_green: severity 0 but protein at 88% (below
        // green's 90% line).
        makeMeal({
          foodName: 'Light snack',
          calories: 200,
          protein: 12,
          fats: 5,
          carbs: 30,
        }),
      ],
    })

    expect(result.current_color).toBe('yellow')
    const colors = result.recommendations.map((r) => r.color)
    // green first, then any subset of light_green/yellow/orange in spec order.
    expect(colors).toContain('green')
    expect(colors).toContain('yellow') // empty combo still hits current=yellow
    expect(colors).not.toContain('orange')
    // Spec order: green → light_green → yellow → orange.
    const order = ['green', 'light_green', 'yellow', 'orange']
    const positions = colors.map((c) => order.indexOf(c))
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })

  test('omits colors with no achievable combination', () => {
    // current = far enough under that no combo lands in green/light_green
    // (need protein ≥ 135 and fat ≥ 30 to reach severity 0). Only a single
    // tiny food, so green is impossible.
    const current = { calories: 800, protein: 20, fat: 5, carbs: 50 }
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [
        makeMeal({ foodName: 'Tiny', calories: 100, protein: 5, fats: 2, carbs: 10 }),
      ],
    })
    // green never reached.
    expect(result.recommendations.find((r) => r.color === 'green')).toBeUndefined()
  })

  test('caps at MAX_VARIANTS_PER_COLOR (3) when many combos qualify', () => {
    // Many candidate foods such that LOTS of combos land in green.
    const current = { calories: 1600, protein: 130, fat: 40, carbs: 180 }
    const foodHistory = [
      makeMeal({ foodName: 'A', calories: 200, protein: 10, fats: 5, carbs: 20 }),
      makeMeal({ foodName: 'B', calories: 220, protein: 12, fats: 6, carbs: 22 }),
      makeMeal({ foodName: 'C', calories: 240, protein: 11, fats: 4, carbs: 24 }),
      makeMeal({ foodName: 'D', calories: 260, protein: 13, fats: 7, carbs: 26 }),
    ]
    const result = generateRecommendations({ goal, current, foodHistory })
    const greens = result.recommendations.filter((r) => r.color === 'green')
    // Spec was "exactly one"; we now surface up to 3 variants per color so
    // the user can pick a combo that matches their appetite.
    expect(greens.length).toBeGreaterThan(0)
    expect(greens.length).toBeLessThanOrEqual(3)
  })

  test('green variants are ranked by closeness to target macros', () => {
    // current is 1500/120/30/150 (1500 kcal under target by 500 etc).
    // Target is 2000/150/60/200.
    const current = { calories: 1500, protein: 120, fat: 30, carbs: 150 }
    // Three foods that all individually land the day in green; only one
    // hits target macros nearly perfectly.
    const perfect = makeMeal({
      foodName: 'Perfect fit',
      calories: 500,
      protein: 30,
      fats: 30,
      carbs: 50,
    })
    const okay = makeMeal({
      foodName: 'Okay snack',
      calories: 200,
      protein: 15,
      fats: 10,
      carbs: 30,
    })
    const minimal = makeMeal({
      foodName: 'Minimal bite',
      calories: 150,
      protein: 13,
      fats: 5,
      carbs: 20,
    })
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [perfect, okay, minimal],
    })
    const greens = result.recommendations.filter((r) => r.color === 'green')
    expect(greens.length).toBeGreaterThan(0)
    // The closest-fit combo should be ranked first — its final macros
    // should sit nearer the 2000/150/60/200 target than any other green.
    const top = greens[0]!
    expect(top.finalMacros.calories).toBeGreaterThanOrEqual(1900)
    expect(top.finalMacros.calories).toBeLessThanOrEqual(2060)
    expect(top.finalMacros.protein).toBeGreaterThanOrEqual(135)
  })

  test('ranks by distance to target — closest macro fit wins, not just any qualifying combo', () => {
    // Both foods individually land the day in green (severity 0 + strict
    // thresholds met). But the precise-fit one nails 100% of every target;
    // the budget-fit one is green-eligible but well below several macros.
    const current = { calories: 1500, protein: 120, fat: 30, carbs: 150 }
    const preciseFit = makeMeal({
      foodName: 'Precise fit',
      calories: 500,
      protein: 30,
      fats: 30,
      carbs: 50,
    })
    // Lands at 1700/142/40/170 — within green's lenient windows (calories
    // ≤+3%, protein ≥90%, fat ≥50%, carbs ±30%) but ~300 kcal short of
    // ideal. Pre-distance the spec's "fewer added calories" tie-breaker
    // would have surfaced this combo first; the new ranker correctly
    // demotes it because the final macros are further from target.
    const budgetFit = makeMeal({
      foodName: 'Budget bite',
      calories: 200,
      protein: 22,
      fats: 10,
      carbs: 20,
    })
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [preciseFit, budgetFit],
    })
    const greens = result.recommendations.filter((r) => r.color === 'green')
    expect(greens.length).toBeGreaterThan(0)
    expect(greens[0]!.foods[0]!.displayName).toBe('Precise fit')
  })

  test('ties on distance fall back to fewer items, then fewer added calories', () => {
    // Two foods whose macros are IDENTICAL (and so produce identical
    // final-day totals + identical distance to target). Tie-break should
    // favour the lighter combo: 1 food beats 2 foods of half each.
    const current = { calories: 1500, protein: 120, fat: 30, carbs: 150 }
    const single = makeMeal({
      foodName: 'Single big',
      calories: 400,
      protein: 25,
      fats: 30,
      carbs: 50,
    })
    const half1 = makeMeal({
      foodName: 'Half a',
      calories: 200,
      protein: 13,
      fats: 15,
      carbs: 25,
    })
    const half2 = makeMeal({
      foodName: 'Half b',
      calories: 200,
      protein: 12,
      fats: 15,
      carbs: 25,
    })
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [single, half1, half2],
    })
    const greens = result.recommendations.filter((r) => r.color === 'green')
    expect(greens.length).toBeGreaterThan(0)
    expect(greens[0]!.foods).toHaveLength(1)
    expect(greens[0]!.foods[0]!.displayName).toBe('Single big')
  })

  test('returns only the empty-combo green recommendation when the day is already green', () => {
    // current already in green: severity 0, protein ≥ 90%, fat ≥ 50%, carbs OK.
    const current = { calories: 2000, protein: 145, fat: 55, carbs: 200 }
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [
        makeMeal({ foodName: 'Tempting', calories: 300, protein: 20, fats: 10, carbs: 40 }),
      ],
    })
    expect(result.current_color).toBe('green')
    expect(result.recommendations).toHaveLength(1)
    const rec = result.recommendations[0]!
    expect(rec.color).toBe('green')
    expect(rec.foods).toHaveLength(0)
    expect(rec.addedMacros).toEqual({ calories: 0, protein: 0, fat: 0, carbs: 0 })
    expect(rec.finalMacros).toEqual(current)
  })

  test('returns an empty list when no target color is reachable', () => {
    // current far under, with only foods so absurdly oversized that the
    // 1.20×target filter drops them. Engine ends up with no candidates.
    const current = { calories: 200, protein: 5, fat: 1, carbs: 10 }
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [
        makeMeal({ foodName: 'Huge', calories: 5000, protein: 100, fats: 100, carbs: 600 }),
      ],
    })
    // With no candidates the only combo evaluated is the empty one — which
    // produces the current_color, and current is blue/red/etc. (not a target).
    expect(result.recommendations).toEqual([])
  })

  test('dedups foods by normalized display name, keeping the most recent', () => {
    // Two log rows for "Греческий йогурт" with different spacing and case —
    // they should collapse to one candidate, picking the more recent macros.
    const old = makeMeal({
      foodName: 'Греческий йогурт',
      calories: 100,
      protein: 8,
      fats: 1,
      carbs: 12,
      daysAgo: 5,
    })
    const recent = makeMeal({
      foodName: 'греческий  йогурт ',
      calories: 150,
      protein: 14,
      fats: 2,
      carbs: 16,
      daysAgo: 1,
    })
    const current = { calories: 1750, protein: 130, fat: 50, carbs: 180 }

    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [old, recent],
    })
    const green = result.recommendations.find((r) => r.color === 'green')
    expect(green).toBeDefined()
    // The 1-food combo that lands us in green must carry the most-recent
    // macros (150 kcal, 14 P) and original-cased display name.
    const food = green!.foods[0]!
    expect(food.calories).toBe(150)
    expect(food.protein).toBe(14)
  })
})
