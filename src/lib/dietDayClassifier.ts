// Single source of truth for day classification. This began as a port of
// CalTracker/DietDayClassifier.swift; that Swift copy is retired along with
// the iOS client, so the sync contract no longer applies and the prose here
// is Russian — it is rendered verbatim by the web UI.
//
// Thresholds and branch order are load-bearing and must not drift: History
// bars, the Today verdict and /chat/recommend all key off them.
//
// Maps a logged day's calories + macros against its targets to exactly one of
// seven semantic colors used across History, Today, and /chat/recommend.
//
//   gray         → required data missing/invalid
//   blue         → substantial under on BOTH calories AND protein
//   red/orange/  → severity from the worst-offending macro
//     yellow
//   green        → strong day, all macros within strict windows
//   light_green  → severity 0 but missed one of green's stricter thresholds
//
// Carbs are intentionally weak: an out-of-band carb day can keep a day from
// being green, but never produces yellow/orange/red.

export type DietDayColor =
  | 'gray'
  | 'blue'
  | 'green'
  | 'light_green'
  | 'yellow'
  | 'orange'
  | 'red'

export type DietDayVerdict = {
  color: DietDayColor
  title: string
  reason: string
}

export type ClassifyInput = {
  calorieGoal: number | null | undefined
  proteinGoal: number | null | undefined
  fatGoal: number | null | undefined
  carbGoal: number | null | undefined
  calories: number | null | undefined
  protein: number | null | undefined
  fat: number | null | undefined
  carbs: number | null | undefined
}

export function classifyDietDay(input: ClassifyInput): DietDayColor {
  return verdictDietDay(input).color
}

export function verdictDietDay(input: ClassifyInput): DietDayVerdict {
  const K = input.calorieGoal
  const P = input.proteinGoal
  const F = input.fatGoal
  const C = input.carbGoal
  const k = input.calories
  const p = input.protein
  const f = input.fat
  const c = input.carbs

  // ── 1. Gray: any required value missing or invalid.
  if (K == null || P == null || F == null || k == null || p == null || f == null) {
    return {
      color: 'gray',
      title: 'Нет данных',
      reason: 'За этот день не хватает целей или записей.',
    }
  }
  if (K <= 0 || P <= 0 || F <= 0) {
    return {
      color: 'gray',
      title: 'Нет данных',
      reason: 'На этот день не выставлены корректные цели.',
    }
  }
  if (k < 0 || p < 0 || f < 0) {
    return {
      color: 'gray',
      title: 'Нет данных',
      reason: 'Записанные за день значения выглядят некорректно.',
    }
  }

  // ── 2. Blue: substantial under-eating on BOTH calories AND protein.
  if (k < 0.75 * K && p < 0.70 * P) {
    return {
      color: 'blue',
      title: 'Сильный недобор',
      reason: `Калории ${intStr(k)} ккал (${pctStr(k, K)} от цели), белок ${intStr(p)} г (${pctStr(p, P)} от цели). И то и другое сильно ниже нормы — низкие калории вместе с низким белком на дефиците грозят потерей мышц.`,
    }
  }

  // ── 3. Severities.
  const cs = calorieSeverity(k, K)
  const ps = proteinSeverity(p, P)
  const fs = fatSeverity(f, F)
  const severity = Math.max(cs, ps, fs)

  if (severity > 0) {
    const issues: string[] = []
    if (cs === severity) {
      const pctOver = Math.round((k / K - 1) * 100)
      const kcalOver = Math.round(k - K)
      issues.push(`калории на +${pctOver}% выше цели (+${kcalOver} ккал)`)
    }
    if (ps === severity) {
      issues.push(`белок ${pctStr(p, P)} от цели (${intStr(p)} / ${intStr(P)} г)`)
    }
    if (fs === severity) {
      issues.push(`жиры ${pctStr(f, F)} от цели (${intStr(f)} / ${intStr(F)} г)`)
    }
    const reason = `${capitalizeFirst(joinList(issues))}.`

    switch (severity) {
      case 3:
        return { color: 'red', title: 'Серьёзное отклонение', reason }
      case 2:
        return { color: 'orange', title: 'Заметное отклонение', reason }
      default:
        return { color: 'yellow', title: 'Мелкая погрешность', reason }
    }
  }

  // ── 4. Severity 0 → green if the stricter green thresholds are met (and
  // carbs, when measured, sit inside ±30%); otherwise light_green.
  const carbsMeasured = C != null && c != null && C > 0
  const carbsAcceptable = (() => {
    if (C == null || c == null || C <= 0) return true
    return Math.abs(c - C) <= 0.30 * C
  })()

  if (k <= 1.03 * K && p >= 0.90 * P && f >= 0.50 * F && carbsAcceptable) {
    const carbsClause = carbsMeasured ? ', углеводы в пределах ±30% от цели' : ''
    return {
      color: 'green',
      title: 'Отличный день',
      reason: `Калории в пределах +3% от цели, белок ≥ 90% от цели, жиры ≥ 50% от цели${carbsClause}.`,
    }
  }

  // light_green — every macro stayed in safe range, but at least one of
  // green's stricter thresholds was missed. Surface which.
  const notes: string[] = []
  if (k > 1.03 * K) {
    const pctOver = Math.round((k / K - 1) * 100)
    notes.push(`калории на +${pctOver}% выше цели (за границей +3% для зелёного)`)
  }
  if (p < 0.90 * P) {
    notes.push(`белок ${pctStr(p, P)} от цели (чуть ниже границы 90% для зелёного)`)
  }
  if (C != null && c != null && C > 0 && Math.abs(c - C) > 0.30 * C) {
    const dev = Math.round((Math.abs(c - C) / C) * 100)
    const dir = c > C ? 'выше' : 'ниже'
    notes.push(`углеводы на ${dev}% ${dir} цели (за коридором ±30% для зелёного)`)
  }

  return {
    color: 'light_green',
    title: 'Хороший день',
    reason:
      notes.length === 0
        ? 'Все макросы в безопасном диапазоне; чуть-чуть не хватило до строгих порогов зелёного.'
        : `Все макросы в безопасном диапазоне, но ${joinList(notes)}.`,
  }
}

function calorieSeverity(k: number, K: number): number {
  if (k > 1.20 * K) return 3
  if (k > 1.10 * K) return 2
  if (k > 1.05 * K) return 1
  return 0
}

function proteinSeverity(p: number, P: number): number {
  if (p < 0.50 * P) return 3
  if (p < 0.70 * P) return 2
  if (p < 0.85 * P) return 1
  return 0
}

// Fat is treated leniently — half the target is still considered fine
// (severity 0). Even at zero fat severity caps at 2, so fat alone never
// paints the day red.
function fatSeverity(f: number, F: number): number {
  if (f < 0.25 * F) return 2
  if (f < 0.50 * F) return 1
  return 0
}

function intStr(v: number): string {
  return `${Math.round(v)}`
}

function pctStr(v: number, total: number): string {
  if (total <= 0) return '—'
  return `${Math.round((v / total) * 100)}%`
}

function capitalizeFirst(s: string): string {
  if (s.length === 0) return s
  return s[0]!.toUpperCase() + s.slice(1)
}

function joinList(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!
  if (items.length === 2) return `${items[0]} и ${items[1]}`
  const head = items.slice(0, -1).join(', ')
  return `${head} и ${items[items.length - 1]}`
}
