import type Anthropic from '@anthropic-ai/sdk'
import { and, asc, eq, gte, lt } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { dailyGoals, meals } from '../db/schema.ts'

// Tool surface exposed to Claude. Two flavors:
//   * read tools  — execute server-side, return data, conversation continues
//   * propose_*   — Claude emits a structured payload; the server saves it as
//                   a card chat message (food_card / goal_card) and feeds back
//                   a confirmation. The client decides whether to commit.

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/

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
      'Read every meal the user logged on a specific calendar date, ordered by time. ' +
      'Use this when the user asks what they ate, how many calories they had, or to compare against the goal.',
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
    name: 'propose_meal',
    description:
      'Propose a new meal entry to the user (from text, photo, or both). DOES NOT write to the database — ' +
      'the user reviews the card in the app and decides whether to commit. ' +
      'Use this whenever the user expresses intent to log food. Estimate macros conservatively.',
    input_schema: {
      type: 'object',
      properties: {
        timestamp: {
          type: 'string',
          description:
            'ISO 8601 timestamp for when the food was eaten. Omit to default to "now" on the client.',
        },
        meal: {
          type: 'string',
          enum: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
        },
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
    name: 'propose_goal',
    description:
      'Propose a daily nutrition goal for a specific calendar date. DOES NOT write to the database — ' +
      'the user reviews the card and decides whether to commit. ' +
      'Use when the user asks to change targets for today or another day.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Calendar date in YYYY-MM-DD format.',
        },
        dayType: { type: 'string', enum: ['training', 'rest'] },
        calorieGoal: { type: 'number' },
        proteinGGoal: { type: 'number' },
        carbsGGoal: { type: 'number' },
        fatGGoal: { type: 'number' },
      },
      required: ['date', 'dayType', 'calorieGoal', 'proteinGGoal', 'carbsGGoal', 'fatGGoal'],
    },
  },
]

export type ToolName = (typeof tools)[number]['name']

export const PROPOSAL_TOOLS = new Set<ToolName>(['propose_meal', 'propose_goal'])

// One-day [start, end) window from a YYYY-MM-DD string, in the server's TZ.
// Meals are stored as timestamptz, so we compare against full timestamps.
function dayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00`)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

function badInput(message: string) {
  return { ok: false as const, error: message }
}

export type ToolExecResult = { ok: true; data: unknown } | { ok: false; error: string }

// Read tools execute against the DB; proposal tools are purely structured and
// do NOT run here — chat.ts handles them by saving a card message.
export async function executeReadTool(
  name: ToolName,
  input: Record<string, unknown>,
  userId: string,
): Promise<ToolExecResult> {
  switch (name) {
    case 'get_goal_for_day': {
      const date = input.date
      if (typeof date !== 'string' || !isoDateRe.test(date)) {
        return badInput('date must be YYYY-MM-DD')
      }
      const [row] = await db
        .select()
        .from(dailyGoals)
        .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, date)))
        .limit(1)
      return { ok: true, data: row ?? null }
    }
    case 'get_meals_for_day': {
      const date = input.date
      if (typeof date !== 'string' || !isoDateRe.test(date)) {
        return badInput('date must be YYYY-MM-DD')
      }
      const { start, end } = dayBounds(date)
      const rows = await db
        .select()
        .from(meals)
        .where(and(eq(meals.userId, userId), gte(meals.timestamp, start), lt(meals.timestamp, end)))
        .orderBy(asc(meals.timestamp))
      return { ok: true, data: rows }
    }
    default:
      return badInput(`tool ${name} is not a read tool`)
  }
}
