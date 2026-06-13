#!/usr/bin/env bun
//
// Imports daily food-diary markdown files (e.g. ~/Downloads/2026-06-10.md)
// into the food-traker-api database for the test user. Idempotent: re-running
// over the same files upserts goals on (userId, date) and replaces all meals
// for that UTC day.
//
// Usage:
//   bun scripts/import-md.ts
//   bun scripts/import-md.ts ~/some/other/dir
//
// Markdown shapes handled:
//   * "## Цели" / "## Цели по питанию" — table with 4 columns (Ккал/Белок/Жиры/Углеводы)
//     or 2 columns (Ккал/Белок only — fat & carbs default to fixed values).
//   * "**Цель:** X ккал / Y г Б / Z г Ж / W г У" — inline single line.
//   * "## Лог питания" / "## Питание" / "## 🍽️ Съедено" — meal table with
//     | Продукт | Ккал | Б | Ж | У |. The "ИТОГО" total row is skipped.
// Day type: heuristic — defaults to "training", flips to "rest" only if the
// markdown contains the literal "Отдых" (or "Rest").

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, gte, lt } from 'drizzle-orm'
import { db } from '../src/db/client.ts'
import { dailyGoals, meals, users } from '../src/db/schema.ts'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const SOURCE_DIR = process.argv[2] ?? `${process.env.HOME}/Downloads`

// The test user lives in Pacific Time. Both the slot times and the per-day
// wipe range are computed against this offset so re-running over the same
// file evicts ALL prior items for that local day — including ones that fall
// into the adjacent UTC day (e.g. a 6 PM PT dinner = 01:00 UTC next day).
// If the test user moves, change this single value.
const USER_TZ_OFFSET_HOURS = -7

// Local-of-the-user clock for each meal slot. Converted to UTC via the offset.
const SLOT_LOCAL_HOUR = {
  Breakfast: 8,
  Lunch: 13,
  Dinner: 18,
} as const

// Defaults when a goals table only has Ккал/Белок (the "гибко" days).
const DEFAULT_FAT_G = 60
const DEFAULT_CARBS_G = 150

type DayType = 'training' | 'rest'
type MealType = keyof typeof SLOT_LOCAL_HOUR

interface Goal {
  date: string
  dayType: DayType
  calorieGoal: number
  proteinGGoal: number
  carbsGGoal: number
  fatGGoal: number
}

interface MealItem {
  meal: MealType
  emoji: string | null
  foodName: string
  calories: number
  protein: number
  carbs: number
  fats: number
  slotIndex: number
}

const inlineGoalRe =
  /\*\*Цель:\*\*\s*(\d+)\s*ккал\s*\/\s*(\d+(?:\.\d+)?)\s*г?\s*Б(?:\s*\/\s*(\d+(?:\.\d+)?)\s*г?\s*Ж(?:\s*\/\s*(\d+(?:\.\d+)?)\s*г?\s*У)?)?/i
// `\b` doesn't work on Cyrillic in JS regex (word-character class is ASCII
// only), so we anchor section headers with `[^\n]*\n` to consume the rest of
// the heading line and capture only the body that follows.
const goalSectionRe = /##[^\n]*?Цели[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i
const mealsSectionRe =
  /##[^\n]*?(?:Лог\s+питания|Питание|Съедено)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i
const emojiRe = /^([\p{Extended_Pictographic}](?:[\u{FE0F}\u{200D}\p{Extended_Pictographic}])*)\s*/u

function parseNumber(s: string): number {
  const cleaned = s.trim().replace(/[—–]/g, '0').replace(/[^\d.]/g, '')
  if (!cleaned) return 0
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

function detectDayType(text: string): DayType {
  // `\b` doesn't span Cyrillic; "Отдых" without boundary is fine — the word
  // and its forms ("Отдыха", "Отдыхай") all signal a rest day.
  return /Отдых|Rest day/i.test(text) ? 'rest' : 'training'
}

function extractGoal(text: string, date: string): Goal | null {
  const inline = text.match(inlineGoalRe)
  if (inline) {
    return {
      date,
      dayType: detectDayType(text),
      calorieGoal: parseNumber(inline[1] ?? ''),
      proteinGGoal: parseNumber(inline[2] ?? ''),
      fatGGoal: inline[3] ? parseNumber(inline[3]) : DEFAULT_FAT_G,
      carbsGGoal: inline[4] ? parseNumber(inline[4]) : DEFAULT_CARBS_G,
    }
  }

  const section = text.match(goalSectionRe)
  if (!section || !section[1]) return null
  const dataLine = section[1].split('\n').find((l) => /^\s*\|\s*\d/.test(l))
  if (!dataLine) return null
  const cells = dataLine.split('|').slice(1, -1).map((s) => s.trim())
  return {
    date,
    dayType: detectDayType(text),
    calorieGoal: parseNumber(cells[0] ?? ''),
    proteinGGoal: parseNumber(cells[1] ?? ''),
    fatGGoal: cells[2] !== undefined ? parseNumber(cells[2]) : DEFAULT_FAT_G,
    carbsGGoal: cells[3] !== undefined ? parseNumber(cells[3]) : DEFAULT_CARBS_G,
  }
}

function extractMeals(text: string): MealItem[] {
  const section = text.match(mealsSectionRe)
  if (!section || !section[1]) return []
  const lines = section[1].split('\n').filter((l) => l.trim().startsWith('|'))
  const items: MealItem[] = []
  for (const line of lines) {
    const cells = line.split('|').slice(1, -1).map((s) => s.trim())
    if (cells.length < 5) continue
    const nameRaw = cells[0] ?? ''
    if (!nameRaw) continue
    if (/^[-:|\s]+$/.test(nameRaw)) continue // separator row
    if (/^\*?\*?Продукт/i.test(nameRaw)) continue // header row
    if (/ИТОГО|TOTAL/i.test(nameRaw)) continue
    const name = nameRaw.replace(/\*+/g, '').trim()
    if (!name) continue
    const emojiMatch = name.match(emojiRe)
    const emoji: string | null = emojiMatch?.[1] ?? null
    const foodName = (emojiMatch ? name.slice(emojiMatch[0].length) : name).trim()
    if (!foodName) continue
    items.push({
      meal: 'Breakfast', // overwritten below by positional split
      emoji,
      foodName,
      calories: parseNumber(cells[1] ?? ''),
      protein: parseNumber(cells[2] ?? ''),
      fats: parseNumber(cells[3] ?? ''),
      carbs: parseNumber(cells[4] ?? ''),
      slotIndex: 0,
    })
  }
  // Positional split: first third → Breakfast, middle → Lunch, last → Dinner.
  // Imperfect, but keeps the time axis sane (no clumps of identical timestamps)
  // and lets the LLM render reasonable "Recent meals" lines.
  const n = items.length
  const cutBL = Math.ceil(n / 3)
  const cutLD = Math.ceil((2 * n) / 3)
  const perSlotIdx: Record<MealType, number> = { Breakfast: 0, Lunch: 0, Dinner: 0 }
  for (let i = 0; i < n; i++) {
    const meal: MealType = i < cutBL ? 'Breakfast' : i < cutLD ? 'Lunch' : 'Dinner'
    const item = items[i]!
    item.meal = meal
    item.slotIndex = perSlotIdx[meal]++
  }
  return items
}

// UTC range covering one local-calendar day for the test user. Wipe + insert
// share this so re-runs are clean regardless of slot UTC drift.
function localDayBoundsUTC(date: string): [Date, Date] {
  const start = new Date(`${date}T00:00:00Z`)
  start.setUTCHours(start.getUTCHours() - USER_TZ_OFFSET_HOURS)
  const end = new Date(start.getTime() + 86_400_000)
  return [start, end]
}

function timestampForItem(date: string, item: MealItem): Date {
  // Anchor at local midnight (in UTC), then add the slot's local hour and
  // a per-item minute offset (keeps timestamps unique within the slot).
  const t = new Date(`${date}T00:00:00Z`)
  t.setUTCHours(
    -USER_TZ_OFFSET_HOURS + SLOT_LOCAL_HOUR[item.meal],
    item.slotIndex,
    0,
    0,
  )
  return t
}

async function main() {
  await db.insert(users).values({ id: USER_ID }).onConflictDoNothing()

  const files = readdirSync(SOURCE_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
    .sort()

  if (files.length === 0) {
    console.error(`No matching markdown files in ${SOURCE_DIR}`)
    process.exit(1)
  }

  console.log(`Importing ${files.length} files from ${SOURCE_DIR}\n`)

  let goalsCount = 0
  let mealsCount = 0
  const skipped: string[] = []

  for (const file of files) {
    const date = file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
    if (!date) continue
    const text = readFileSync(join(SOURCE_DIR, file), 'utf8')

    const goal = extractGoal(text, date)
    if (goal && goal.calorieGoal > 0) {
      await db
        .insert(dailyGoals)
        .values({ userId: USER_ID, ...goal })
        .onConflictDoUpdate({
          target: [dailyGoals.userId, dailyGoals.date],
          set: {
            dayType: goal.dayType,
            calorieGoal: goal.calorieGoal,
            proteinGGoal: goal.proteinGGoal,
            carbsGGoal: goal.carbsGGoal,
            fatGGoal: goal.fatGGoal,
            updatedAt: new Date(),
          },
        })
      goalsCount++
    }

    // Idempotency: wipe every meal whose timestamp falls inside the user's
    // LOCAL day for `date`, regardless of which UTC day it lives in. Catches
    // late-evening items the previous run pushed into the next UTC day, plus
    // anything inserted manually via curl that lined up with this local day.
    const [dayStart, dayEnd] = localDayBoundsUTC(date)
    await db
      .delete(meals)
      .where(
        and(
          eq(meals.userId, USER_ID),
          gte(meals.timestamp, dayStart),
          lt(meals.timestamp, dayEnd),
        ),
      )

    const items = extractMeals(text)
    for (const item of items) {
      await db.insert(meals).values({
        userId: USER_ID,
        timestamp: timestampForItem(date, item),
        meal: item.meal,
        emoji: item.emoji,
        foodName: item.foodName,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fats: item.fats,
      })
      mealsCount++
    }

    if (!goal && items.length === 0) skipped.push(file)
    const goalCell = goal
      ? `${goal.calorieGoal}/${goal.proteinGGoal}/${goal.carbsGGoal}/${goal.fatGGoal} ${goal.dayType}`
      : '—'
    console.log(`${date}  goal=${goalCell.padEnd(28)}  meals=${items.length}`)
  }

  console.log(`\nDone. Goals upserted: ${goalsCount}, meals inserted: ${mealsCount}`)
  if (skipped.length > 0) {
    console.log(`Skipped (nothing parseable): ${skipped.join(', ')}`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
