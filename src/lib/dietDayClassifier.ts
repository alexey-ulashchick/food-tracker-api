// Server-side port of CalTracker/DietDayClassifier.swift. KEEP IN SYNC with
// the Swift original: the iOS app is being migrated to consume colors from
// the server, but every threshold and decision branch must match the Swift
// source exactly until that migration lands and the Swift copy is removed.
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
      title: 'No data',
      reason: 'Targets or actuals are missing for this day.',
    }
  }
  if (K <= 0 || P <= 0 || F <= 0) {
    return {
      color: 'gray',
      title: 'No data',
      reason: 'No valid targets are set for this day.',
    }
  }
  if (k < 0 || p < 0 || f < 0) {
    return {
      color: 'gray',
      title: 'No data',
      reason: 'Logged actuals look invalid for this day.',
    }
  }

  // ── 2. Blue: substantial under-eating on BOTH calories AND protein.
  if (k < 0.75 * K && p < 0.70 * P) {
    return {
      color: 'blue',
      title: 'Substantially under-eaten',
      reason: `Calories ${intStr(k)} kcal (${pctStr(k, K)} of target) and protein ${intStr(p)} g (${pctStr(p, P)} of goal). Both ran well under — pairing low calories with low protein risks muscle loss on a cut.`,
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
      issues.push(`calories ran +${pctOver}% over goal (+${kcalOver} kcal)`)
    }
    if (ps === severity) {
      issues.push(`protein at ${pctStr(p, P)} of goal (${intStr(p)} / ${intStr(P)} g)`)
    }
    if (fs === severity) {
      issues.push(`fat at ${pctStr(f, F)} of target (${intStr(f)} / ${intStr(F)} g)`)
    }
    const reason = `${capitalizeFirst(joinList(issues))}.`

    switch (severity) {
      case 3:
        return { color: 'red', title: 'Major issue', reason }
      case 2:
        return { color: 'orange', title: 'Significant issue', reason }
      default:
        return { color: 'yellow', title: 'Minor issue', reason }
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
    const carbsClause = carbsMeasured ? ', carbs within ±30% of target' : ''
    return {
      color: 'green',
      title: 'Strong day',
      reason: `Calories within +3% of target, protein ≥ 90% of goal, fat ≥ 50% of target${carbsClause}.`,
    }
  }

  // light_green — every macro stayed in safe range, but at least one of
  // green's stricter thresholds was missed. Surface which.
  const notes: string[] = []
  if (k > 1.03 * K) {
    const pctOver = Math.round((k / K - 1) * 100)
    notes.push(`calories ran +${pctOver}% over goal (above the +3% green line)`)
  }
  if (p < 0.90 * P) {
    notes.push(`protein at ${pctStr(p, P)} of goal (just below the 90% green line)`)
  }
  if (C != null && c != null && C > 0 && Math.abs(c - C) > 0.30 * C) {
    const dev = Math.round((Math.abs(c - C) / C) * 100)
    const dir = c > C ? 'over' : 'under'
    notes.push(`carbs ${dev}% ${dir} target (outside the ±30% green band)`)
  }

  return {
    color: 'light_green',
    title: 'Good day',
    reason:
      notes.length === 0
        ? 'Every macro stayed in safe range; one of the stricter green thresholds was just missed.'
        : `Every macro stayed in safe range, but ${joinList(notes)}.`,
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
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  const head = items.slice(0, -1).join(', ')
  return `${head}, and ${items[items.length - 1]}`
}
