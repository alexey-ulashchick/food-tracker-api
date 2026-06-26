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
  date: '2026-06-26',
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
  test('caps surfaced recommendations at MAX_VARIANTS (10)', () => {
    // Pool large enough to yield many qualifying combos.
    const current = { calories: 1600, protein: 130, fat: 40, carbs: 180 }
    const foodHistory = Array.from({ length: 6 }, (_, i) =>
      makeMeal({
        foodName: `Food ${i}`,
        calories: 180 + i * 10,
        protein: 10 + i,
        fats: 5 + i,
        carbs: 20 + i,
      }),
    )
    const result = generateRecommendations({ goal, current, foodHistory })
    expect(result.recommendations.length).toBeLessThanOrEqual(10)
    expect(result.recommendations.length).toBeGreaterThan(0)
  })

  test('ranks variants by distance to target — closest macro fit lands first', () => {
    // Three foods that all individually land the day in green; only one
    // hits target macros nearly perfectly.
    const current = { calories: 1500, protein: 120, fat: 30, carbs: 150 }
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
    expect(result.recommendations.length).toBeGreaterThan(0)
    const top = result.recommendations[0]!
    expect(top.finalMacros.calories).toBeGreaterThanOrEqual(1900)
    expect(top.finalMacros.calories).toBeLessThanOrEqual(2060)
    expect(top.finalMacros.protein).toBeGreaterThanOrEqual(135)
  })

  test('any single food appears in at most 3 of the surfaced variants', () => {
    // A "magnet" food whose macros land the day near target on its own —
    // without the across-deck cap it would dominate every top-distance
    // combo. With the cap, after 3 picks containing it, the next-best
    // combos are forced to switch to other foods.
    const current = { calories: 1500, protein: 120, fat: 30, carbs: 150 }
    const magnet = makeMeal({
      foodName: 'Magnet',
      calories: 500,
      protein: 30,
      fats: 30,
      carbs: 50,
    })
    // A few weaker fillers so distance-sorted top-10 includes both magnet-
    // heavy combos and magnet-free combos.
    const fillers = Array.from({ length: 6 }, (_, i) =>
      makeMeal({
        foodName: `Filler ${i}`,
        calories: 100 + i * 30,
        protein: 5 + i,
        fats: 3 + i,
        carbs: 10 + i * 5,
      }),
    )
    const result = generateRecommendations({
      goal,
      current,
      foodHistory: [magnet, ...fillers],
    })

    const usage = new Map<string, number>()
    for (const rec of result.recommendations) {
      for (const f of rec.foods) {
        usage.set(f.displayName, (usage.get(f.displayName) ?? 0) + 1)
      }
    }
    for (const [name, count] of usage) {
      expect(count, `food "${name}" appears ${count} times`).toBeLessThanOrEqual(3)
    }
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
    expect(result.recommendations.length).toBeGreaterThan(0)
    const top = result.recommendations[0]!
    expect(top.foods).toHaveLength(1)
    expect(top.foods[0]!.displayName).toBe('Single big')
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

  test('returns an empty list when no combo can be formed', () => {
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
    expect(result.recommendations.length).toBeGreaterThan(0)
    // The 1-food combo that lands closest to target must carry the
    // most-recent macros (150 kcal, 14 P) and the original-cased display
    // name from the freshest occurrence.
    const top = result.recommendations[0]!
    expect(top.foods[0]!.calories).toBe(150)
    expect(top.foods[0]!.protein).toBe(14)
  })
})
