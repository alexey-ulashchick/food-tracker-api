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
    expect(v.title).toBe('Отличный день')
    expect(v.reason).toContain('Калории в пределах +3%')
    expect(v.reason).toContain('белок ≥ 90%')
    expect(v.reason).toContain('жиры ≥ 50%')
    expect(v.reason).toContain('углеводы в пределах ±30%')
  })

  test('red verdict explains which dimension drove the verdict', () => {
    const v = verdictDietDay({ ...T, calories: 2500, protein: 150, fat: 60, carbs: 200 })
    expect(v.color).toBe('red')
    expect(v.title).toBe('Серьёзное отклонение')
    // capitalizeFirst has to work on Cyrillic, not just ASCII.
    expect(v.reason).toContain('Калории на +25% выше цели')
    expect(v.reason).toContain('+500 ккал')
  })

  test('blue verdict quotes the actual deltas', () => {
    const v = verdictDietDay({ ...T, calories: 1400, protein: 90, fat: 30, carbs: 200 })
    expect(v.color).toBe('blue')
    expect(v.title).toBe('Сильный недобор')
    expect(v.reason).toContain('1400 ккал')
    expect(v.reason).toContain('70%')
    expect(v.reason).toContain('белок')
  })

  test('gray verdict distinguishes missing data from invalid targets', () => {
    const missing = verdictDietDay({ ...T, calories: null, protein: 1, fat: 1, carbs: 1 })
    expect(missing.title).toBe('Нет данных')
    expect(missing.reason).toContain('не хватает целей или записей')

    const noTargets = verdictDietDay({
      ...T,
      calorieGoal: 0,
      calories: 1,
      protein: 1,
      fat: 1,
      carbs: 1,
    })
    expect(noTargets.reason).toContain('не выставлены корректные цели')
  })

  test('light_green lists every missed threshold, joined with "и"', () => {
    const v = verdictDietDay({ ...T, calories: 2060, protein: 130, fat: 55, carbs: 300 })
    expect(v.color).toBe('light_green')
    expect(v.title).toBe('Хороший день')
    expect(v.reason).toContain('белок 87% от цели')
    expect(v.reason).toContain('углеводы на 50% выше цели')
    // joinList must use the Russian conjunction, not "and".
    expect(v.reason).toContain(' и ')
    expect(v.reason).not.toContain(' and ')
  })

  test('no verdict leaks English prose', () => {
    const inputs = [
      { calories: 1400, protein: 90, fat: 30, carbs: 200 },
      { calories: 2500, protein: 150, fat: 60, carbs: 200 },
      { calories: 2300, protein: 150, fat: 60, carbs: 200 },
      { calories: 2100, protein: 150, fat: 60, carbs: 200 },
      { calories: 2000, protein: 150, fat: 60, carbs: 200 },
      { calories: 2000, protein: 130, fat: 55, carbs: 200 },
      { calories: null, protein: 1, fat: 1, carbs: 1 },
    ]
    for (const input of inputs) {
      const v = verdictDietDay({ ...T, ...input })
      expect(v.title).toMatch(/[А-Яа-яЁё]/)
      expect(v.reason).toMatch(/[А-Яа-яЁё]/)
      // Any surviving Latin letters would be a missed translation. Digits,
      // punctuation and the ккал/г units are all Cyrillic or symbolic.
      expect(v.reason).not.toMatch(/[A-Za-z]/)
    }
  })
})
