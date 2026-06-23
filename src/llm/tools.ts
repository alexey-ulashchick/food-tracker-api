import type Anthropic from '@anthropic-ai/sdk'
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { dailyGoals, meals, memories } from '../db/schema.ts'

// Tool surface exposed to Claude. Two flavors:
//   * read tools  — fetch data and return it; conversation continues so the
//                   model can react.
//   * write tools — execute a database mutation server-side and return the
//                   resulting row. The chat route additionally logs an action
//                   card (meal_added / meal_removed / meal_updated / goal_set)
//                   describing what changed, so the iOS chat shows a card.

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const mealEnumValues = ['Breakfast', 'Lunch', 'Dinner', 'Snack'] as const
const dayTypeValues = ['training', 'rest'] as const

export const tools: Anthropic.Tool[] = [
  {
    name: 'get_goal_for_day',
    description:
      "Read the user's daily nutrition goal for a specific calendar date. " +
      'Returns the row (calorie/protein/carbs/fat targets and dayType) or null if no goal is set for that date.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Calendar date in YYYY-MM-DD format.',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_meals_for_day',
    description:
      'Read every meal the user logged on a specific calendar date (in their local TZ), ordered by time. ' +
      'Each row includes its id — use that id when calling update_meal or delete_meal. ' +
      'Use this when the user asks what they ate, or when you need a meal id to edit/remove an entry. ' +
      'tzOffsetMin defaults to the user\'s current TZ; only set it to look up "what I ate that day in TZ X" while travelling.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Calendar date in YYYY-MM-DD format.',
        },
        tzOffsetMin: {
          type: 'integer',
          description:
            "TZ offset (minutes east of UTC) defining the calendar day. Omit to use the user's current TZ.",
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'add_meal',
    description:
      'Log a new meal for the user. Writes immediately — the iOS app shows an "added" card describing what was logged. ' +
      'Estimate macros conservatively from the description, photo, or both. ' +
      "tzOffsetMin defaults to the user's current TZ; only set it when logging a meal eaten in a different timezone (e.g. while travelling).",
    input_schema: {
      type: 'object',
      properties: {
        timestamp: {
          type: 'string',
          description:
            'ISO 8601 timestamp for when the food was eaten. Omit to default to "now" on the server.',
        },
        tzOffsetMin: {
          type: 'integer',
          description:
            "Local timezone offset in minutes east of UTC at the place the meal was eaten (matches iOS's TimeZone.current.secondsFromGMT() / 60). Omit to use the user's current TZ.",
        },
        meal: { type: 'string', enum: [...mealEnumValues] },
        emoji: {
          type: 'string',
          description: 'A single food emoji that represents the dish.',
        },
        foodName: { type: 'string' },
        calories: { type: 'number' },
        protein: { type: 'number', description: 'Grams of protein.' },
        carbs: { type: 'number', description: 'Grams of carbohydrates.' },
        fats: { type: 'number', description: 'Grams of fat.' },
      },
      required: ['meal', 'foodName', 'calories', 'protein', 'carbs', 'fats'],
    },
  },
  {
    name: 'update_meal',
    description:
      'Edit a previously-logged meal in place. Use when the user corrects macros, name, portion, meal slot, or the timezone the meal was eaten in. ' +
      'Pass only the fields that change; omitted fields are left untouched. ' +
      'Look up the id with get_meals_for_day if you do not already have it.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the meal row to update.' },
        timestamp: { type: 'string', description: 'ISO 8601 timestamp.' },
        tzOffsetMin: {
          type: 'integer',
          description: 'Local TZ offset in minutes east of UTC at the place the meal was eaten.',
        },
        meal: { type: 'string', enum: [...mealEnumValues] },
        emoji: { type: 'string' },
        foodName: { type: 'string' },
        calories: { type: 'number' },
        protein: { type: 'number' },
        carbs: { type: 'number' },
        fats: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_meal',
    description:
      'Remove a previously-logged meal entirely. Use when the user says they did not eat it, ' +
      'or when replacing a wrong entry with a fresh add_meal call. ' +
      'Look up the id with get_meals_for_day if you do not already have it.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the meal row to delete.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_goal',
    description:
      'Create or replace the daily nutrition goal for a specific calendar date. Writes immediately; the iOS app shows a "goal set" card.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Calendar date in YYYY-MM-DD format.',
        },
        dayType: { type: 'string', enum: [...dayTypeValues] },
        calorieGoal: { type: 'number' },
        proteinGGoal: { type: 'number' },
        carbsGGoal: { type: 'number' },
        fatGGoal: { type: 'number' },
      },
      required: ['date', 'dayType', 'calorieGoal', 'proteinGGoal', 'carbsGGoal', 'fatGGoal'],
    },
  },
  {
    name: 'add_memory',
    description:
      'Save a long-lived fact, preference, dish, recipe, or behaviour the user explicitly asked you to remember. ' +
      'Use ONLY when the user signals "remember", "обычно я", "запомни", names a recurring dish/recipe, an allergy, a goal, a routine. ' +
      'Do NOT use for one-off events that should go into add_meal instead. ' +
      'Keep `content` to a single short sentence; structure it like "Allergy: lactose" or "Любимый завтрак: овсянка с бананом".',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'A single short sentence describing the memory.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'update_memory',
    description:
      "Replace the content of an existing memory in place. Use when the user refines a previously-saved memory (e.g. 'не лактоза, а молочка'). The current memory list is in the system prompt — pick the id from there.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the memory row to update.' },
        content: { type: 'string', description: 'New content. Replaces the old content fully.' },
      },
      required: ['id', 'content'],
    },
  },
  {
    name: 'delete_memory',
    description:
      "Forget a memory the user no longer wants stored. Use when the user says 'забудь', 'это уже не так', or explicitly asks to remove a fact. Pick the id from the Memories block in the system prompt.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the memory row to delete.' },
      },
      required: ['id'],
    },
  },
]

export type ToolName = (typeof tools)[number]['name']

const READ_TOOL_NAMES = new Set<ToolName>(['get_goal_for_day', 'get_meals_for_day'])
const WRITE_TOOL_NAMES = new Set<ToolName>([
  'add_meal',
  'update_meal',
  'delete_meal',
  'set_goal',
  'add_memory',
  'update_memory',
  'delete_memory',
])

export const READ_ONLY_TOOLS: Anthropic.Tool[] = tools.filter((t) =>
  READ_TOOL_NAMES.has(t.name as ToolName),
)

export function isWriteTool(name: string): name is ToolName {
  return WRITE_TOOL_NAMES.has(name as ToolName)
}

export type Meal = typeof meals.$inferSelect
export type Goal = typeof dailyGoals.$inferSelect
export type Memory = typeof memories.$inferSelect

export type ToolExecResult =
  | { ok: true; kind: 'read'; data: unknown }
  | { ok: true; kind: 'meal_added'; meal: Meal }
  | { ok: true; kind: 'meal_updated'; meal: Meal; before: Meal }
  | { ok: true; kind: 'meal_removed'; meal: Meal }
  | { ok: true; kind: 'goal_set'; goal: Goal }
  | { ok: true; kind: 'memory_added'; memory: Memory }
  | { ok: true; kind: 'memory_updated'; memory: Memory; before: Memory }
  | { ok: true; kind: 'memory_removed'; memory: Memory }
  | { ok: false; error: string }

// One-day [start, end) window from a YYYY-MM-DD literal interpreted in a
// caller-supplied TZ offset (minutes east of UTC). Both bounds are real UTC
// instants. We compute the offset for the requested wall-clock midnight by
// taking `00:00 UTC + offset minutes` first, which gives "midnight at the
// requested local TZ, expressed in UTC".
function dayBounds(date: string, offsetMin: number): { start: Date; end: Date } {
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime()
  // If the caller's local midnight is at, say, +03:00, then in UTC it's
  // 21:00 of the previous day. Subtract the offset to get the UTC instant
  // when the requested local day begins.
  const start = new Date(utcMidnight - offsetMin * 60_000)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

function badInput(message: string): ToolExecResult {
  return { ok: false, error: message }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asInteger(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) ? v : undefined
}

function asMealType(v: unknown): (typeof mealEnumValues)[number] | undefined {
  return typeof v === 'string' && (mealEnumValues as readonly string[]).includes(v)
    ? (v as (typeof mealEnumValues)[number])
    : undefined
}

function asDayType(v: unknown): (typeof dayTypeValues)[number] | undefined {
  return typeof v === 'string' && (dayTypeValues as readonly string[]).includes(v)
    ? (v as (typeof dayTypeValues)[number])
    : undefined
}

export type ExecuteToolOpts = {
  // The current request's TZ offset (minutes east of UTC). Used as a fallback
  // when add_meal does not specify tzOffsetMin in its input — i.e. the chat
  // route auto-stamps the user's current TZ on freshly-logged meals.
  defaultTzOffsetMin?: number
}

// Single dispatch for both flavors. Read tools return data; write tools mutate
// the DB and return the affected row(s) so chat.ts can persist a matching
// action card.
export async function executeTool(
  name: ToolName,
  input: Record<string, unknown>,
  userId: string,
  opts: ExecuteToolOpts = {},
): Promise<ToolExecResult> {
  switch (name) {
    case 'get_goal_for_day': {
      const date = asString(input.date)
      if (!date || !isoDateRe.test(date)) return badInput('date must be YYYY-MM-DD')
      const [row] = await db
        .select()
        .from(dailyGoals)
        .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, date)))
        .limit(1)
      return { ok: true, kind: 'read', data: row ?? null }
    }
    case 'get_meals_for_day': {
      const date = asString(input.date)
      if (!date || !isoDateRe.test(date)) return badInput('date must be YYYY-MM-DD')
      const offsetMin = asInteger(input.tzOffsetMin) ?? opts.defaultTzOffsetMin ?? 0
      const { start, end } = dayBounds(date, offsetMin)
      const rows = await db
        .select()
        .from(meals)
        .where(and(eq(meals.userId, userId), gte(meals.timestamp, start), lt(meals.timestamp, end)))
        .orderBy(asc(meals.timestamp))
      return { ok: true, kind: 'read', data: rows }
    }
    case 'add_meal': {
      const meal = asMealType(input.meal)
      const foodName = asString(input.foodName)
      const calories = asNumber(input.calories)
      const protein = asNumber(input.protein)
      const carbs = asNumber(input.carbs)
      const fats = asNumber(input.fats)
      if (
        !meal ||
        !foodName ||
        calories === undefined ||
        protein === undefined ||
        carbs === undefined ||
        fats === undefined
      ) {
        return badInput('add_meal requires meal, foodName, calories, protein, carbs, fats')
      }
      const tsRaw = asString(input.timestamp)
      const ts = tsRaw ? new Date(tsRaw) : undefined
      if (ts && Number.isNaN(ts.getTime())) {
        return badInput('timestamp must be ISO 8601 if provided')
      }
      const tzOffsetMin = asInteger(input.tzOffsetMin) ?? opts.defaultTzOffsetMin ?? null
      const [row] = await db
        .insert(meals)
        .values({
          userId,
          timestamp: ts,
          tzOffsetMin,
          meal,
          emoji: asString(input.emoji) ?? null,
          foodName,
          calories,
          protein,
          carbs,
          fats,
        })
        .returning()
      return { ok: true, kind: 'meal_added', meal: row! }
    }
    case 'update_meal': {
      const id = asString(input.id)
      if (!id || !uuidRe.test(id)) return badInput('id must be a UUID')

      const [before] = await db
        .select()
        .from(meals)
        .where(and(eq(meals.id, id), eq(meals.userId, userId)))
        .limit(1)
      if (!before) return badInput(`meal ${id} not found`)

      const patch: Partial<typeof meals.$inferInsert> = {}
      const meal = asMealType(input.meal)
      if (meal !== undefined) patch.meal = meal
      const foodName = asString(input.foodName)
      if (foodName !== undefined) patch.foodName = foodName
      if ('emoji' in input) patch.emoji = asString(input.emoji) ?? null
      const calories = asNumber(input.calories)
      if (calories !== undefined) patch.calories = calories
      const protein = asNumber(input.protein)
      if (protein !== undefined) patch.protein = protein
      const carbs = asNumber(input.carbs)
      if (carbs !== undefined) patch.carbs = carbs
      const fats = asNumber(input.fats)
      if (fats !== undefined) patch.fats = fats
      const tsRaw = asString(input.timestamp)
      if (tsRaw !== undefined) {
        const ts = new Date(tsRaw)
        if (Number.isNaN(ts.getTime())) return badInput('timestamp must be ISO 8601 if provided')
        patch.timestamp = ts
      }
      // tzOffsetMin can be cleared by passing null, set to a number, or left
      // alone by omitting the key entirely.
      if ('tzOffsetMin' in input) {
        const v = input.tzOffsetMin
        if (v === null) {
          patch.tzOffsetMin = null
        } else {
          const n = asInteger(v)
          if (n === undefined) return badInput('tzOffsetMin must be an integer or null')
          patch.tzOffsetMin = n
        }
      }
      if (Object.keys(patch).length === 0) {
        return badInput('update_meal requires at least one field besides id')
      }

      const [row] = await db
        .update(meals)
        .set(patch)
        .where(and(eq(meals.id, id), eq(meals.userId, userId)))
        .returning()
      return { ok: true, kind: 'meal_updated', meal: row!, before }
    }
    case 'delete_meal': {
      const id = asString(input.id)
      if (!id || !uuidRe.test(id)) return badInput('id must be a UUID')
      const [row] = await db
        .delete(meals)
        .where(and(eq(meals.id, id), eq(meals.userId, userId)))
        .returning()
      if (!row) return badInput(`meal ${id} not found`)
      return { ok: true, kind: 'meal_removed', meal: row }
    }
    case 'set_goal': {
      const date = asString(input.date)
      if (!date || !isoDateRe.test(date)) return badInput('date must be YYYY-MM-DD')
      const dayType = asDayType(input.dayType)
      const calorieGoal = asNumber(input.calorieGoal)
      const proteinGGoal = asNumber(input.proteinGGoal)
      const carbsGGoal = asNumber(input.carbsGGoal)
      const fatGGoal = asNumber(input.fatGGoal)
      if (
        !dayType ||
        calorieGoal === undefined ||
        proteinGGoal === undefined ||
        carbsGGoal === undefined ||
        fatGGoal === undefined
      ) {
        return badInput(
          'set_goal requires dayType, calorieGoal, proteinGGoal, carbsGGoal, fatGGoal',
        )
      }
      const [row] = await db
        .insert(dailyGoals)
        .values({ userId, date, dayType, calorieGoal, proteinGGoal, carbsGGoal, fatGGoal })
        .onConflictDoUpdate({
          target: [dailyGoals.userId, dailyGoals.date],
          set: {
            dayType,
            calorieGoal,
            proteinGGoal,
            carbsGGoal,
            fatGGoal,
            updatedAt: new Date(),
          },
        })
        .returning()
      return { ok: true, kind: 'goal_set', goal: row! }
    }
    case 'add_memory': {
      const content = asString(input.content)?.trim()
      if (!content) return badInput('add_memory requires a non-empty content string')
      if (content.length > 500) return badInput('memory content must be ≤ 500 chars')
      const [row] = await db.insert(memories).values({ userId, content }).returning()
      return { ok: true, kind: 'memory_added', memory: row! }
    }
    case 'update_memory': {
      const id = asString(input.id)
      if (!id || !uuidRe.test(id)) return badInput('id must be a UUID')
      const content = asString(input.content)?.trim()
      if (!content) return badInput('update_memory requires a non-empty content string')
      if (content.length > 500) return badInput('memory content must be ≤ 500 chars')

      const [before] = await db
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), eq(memories.userId, userId)))
        .limit(1)
      if (!before) return badInput(`memory ${id} not found`)

      const [row] = await db
        .update(memories)
        .set({ content, updatedAt: new Date() })
        .where(and(eq(memories.id, id), eq(memories.userId, userId)))
        .returning()
      return { ok: true, kind: 'memory_updated', memory: row!, before }
    }
    case 'delete_memory': {
      const id = asString(input.id)
      if (!id || !uuidRe.test(id)) return badInput('id must be a UUID')
      const [row] = await db
        .delete(memories)
        .where(and(eq(memories.id, id), eq(memories.userId, userId)))
        .returning()
      if (!row) return badInput(`memory ${id} not found`)
      return { ok: true, kind: 'memory_removed', memory: row }
    }
    default:
      return badInput(`unknown tool: ${name}`)
  }
}

// Loads all memories for a user, newest-updated first. Used by chat.ts to
// inject the Memories block into every system prompt.
export async function loadMemories(userId: string): Promise<Memory[]> {
  return db
    .select()
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(desc(memories.updatedAt))
}
