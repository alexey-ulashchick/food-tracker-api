import { describe, expect, test } from 'bun:test'
import { classifyDietDay, verdictDietDay } from '../src/lib/dietDayClassifier.ts'

// Standard target: 2000 kcal, 150 P, 60 F, 200 C.
const T = { calorieGoal: 2000, proteinGoal: 150, fatGoal: 60, carbGoal: 200 }

describe('classifyDietDay', () => {
  test('gray when required actuals missing', () => {
    expect(classifyDietDay({ ...T, calories: null, protein: 100, fat: 50, carbs: 200 })).toBe(
      'gray',
    )
    expect(classifyDietDay({ ...T, calories: 2000, protein: null, fat: 50, carbs: 200 })).toBe(
      'gray',
    )
  })

  test('gray when targets missing or non-positive', () => {
    expect(
      classifyDietDay({
        calorieGoal: 0,
        proteinGoal: 150,
        fatGoal: 60,
        carbGoal: 200,
        calories: 2000,
        protein: 150,
        fat: 60,
        carbs: 200,
      }),
    ).toBe('gray')
    expect(
      classifyDietDay({
        calorieGoal: 2000,
        proteinGoal: null,
        fatGoal: 60,
        carbGoal: 200,
        calories: 2000,
        protein: 150,
        fat: 60,
        carbs: 200,
      }),
    ).toBe('gray')
  })

  test('gray when actuals negative', () => {
    expect(classifyDietDay({ ...T, calories: -1, protein: 150, fat: 60, carbs: 200 })).toBe(
      'gray',
    )
  })

  test('blue when both calories and protein are deeply under', () => {
    // k = 1400 (70%), p = 90 (60%) — both below thresholds (0.75K, 0.70P).
    expect(classifyDietDay({ ...T, calories: 1400, protein: 90, fat: 30, carbs: 200 })).toBe(
      'blue',
    )
  })

  test('not blue when only one of calories/protein is deeply under', () => {
    // k = 1400 (70%), p = 130 (87%) — calories under but protein OK.
    expect(classifyDietDay({ ...T, calories: 1400, protein: 130, fat: 30, carbs: 200 })).not.toBe(
      'blue',
    )
  })

  test('red when calories over +20%', () => {
    expect(classifyDietDay({ ...T, calories: 2500, protein: 150, fat: 60, carbs: 200 })).toBe(
      'red',
    )
  })

  test('red when protein under 50% of goal', () => {
    expect(classifyDietDay({ ...T, calories: 2000, protein: 70, fat: 60, carbs: 200 })).toBe(
      'red',
    )
  })

  test('orange when calories +10..20% over', () => {
    expect(classifyDietDay({ ...T, calories: 2300, protein: 150, fat: 60, carbs: 200 })).toBe(
      'orange',
    )
  })

  test('orange when fat under 25% of target', () => {
    expect(classifyDietDay({ ...T, calories: 2000, protein: 150, fat: 10, carbs: 200 })).toBe(
      'orange',
    )
  })

  test('yellow when calories +5..10% over', () => {
    expect(classifyDietDay({ ...T, calories: 2100, protein: 150, fat: 60, carbs: 200 })).toBe(
      'yellow',
    )
  })

  test('yellow when protein 70..85% of goal', () => {
    expect(classifyDietDay({ ...T, calories: 2000, protein: 120, fat: 60, carbs: 200 })).toBe(
      'yellow',
    )
  })

  test('green when all macros within strict windows', () => {
    expect(classifyDietDay({ ...T, calories: 2000, protein: 150, fat: 60, carbs: 200 })).toBe(
      'green',
    )
  })

  test('green with no carb measurement (carbs missing on actual)', () => {
    expect(classifyDietDay({ ...T, calories: 2000, protein: 150, fat: 60, carbs: null })).toBe(
      'green',
    )
  })

  test('light_green when protein dips just below 90% but stays above 85%', () => {
    // p = 130 (87%) — past the yellow line (≥85%) but below green's 90% line.
    expect(classifyDietDay({ ...T, calories: 2000, protein: 130, fat: 60, carbs: 200 })).toBe(
      'light_green',
    )
  })

  test('light_green when carbs outside ±30% band', () => {
    // All else green-eligible, but carbs at 280 (40% over).
    expect(classifyDietDay({ ...T, calories: 2000, protein: 150, fat: 60, carbs: 280 })).toBe(
      'light_green',
    )
  })

  test('light_green when calories run between +3% and +5% (severity 0, green miss)', () => {
    expect(classifyDietDay({ ...T, calories: 2080, protein: 150, fat: 60, carbs: 200 })).toBe(
      'light_green',
    )
  })
})

describe('verdictDietDay', () => {
  test('green verdict mentions all three strict checks', () => {
    const v = verdictDietDay({ ...T, calories: 2000, protein: 150, fat: 60, carbs: 200 })
    expect(v.color).toBe('green')
    expect(v.title).toBe('Strong day')
    expect(v.reason).toContain('Calories within +3%')
    expect(v.reason).toContain('protein ≥ 90%')
    expect(v.reason).toContain('fat ≥ 50%')
    expect(v.reason).toContain('carbs within ±30%')
  })

  test('red verdict explains which dimension drove the verdict', () => {
    const v = verdictDietDay({ ...T, calories: 2500, protein: 150, fat: 60, carbs: 200 })
    expect(v.color).toBe('red')
    expect(v.title).toBe('Major issue')
    expect(v.reason).toContain('calories ran +25%')
  })

  test('blue verdict quotes the actual deltas', () => {
    const v = verdictDietDay({ ...T, calories: 1400, protein: 90, fat: 30, carbs: 200 })
    expect(v.color).toBe('blue')
    expect(v.title).toBe('Substantially under-eaten')
    expect(v.reason).toContain('1400 kcal')
    expect(v.reason).toContain('70%')
    expect(v.reason).toContain('protein')
  })
})
