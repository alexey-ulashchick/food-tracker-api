import type Anthropic from '@anthropic-ai/sdk'
import { and, desc, eq, gte } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { chatMessages, dailyGoals, meals } from '../db/schema.ts'
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, anthropic } from '../llm/anthropic.ts'
import { type ToolName, executeTool, isWriteTool, tools } from '../llm/tools.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

const HISTORY_DEPTH = 30
const MEAL_LOOKBACK_DAYS = 30
const MAX_TOOL_ITERATIONS = 5
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
})

type ChatMessage = typeof chatMessages.$inferSelect
type Meal = typeof meals.$inferSelect
type Goal = typeof dailyGoals.$inferSelect

type ChatContext = {
  today: string
  history: ChatMessage[]
  recentMeals: Meal[]
  todaysGoal: Goal | undefined
}

export const chatRoute = new Hono<AuthEnv>()
  .use(auth)
  // Returns the last `limit` messages, newest-first. Client reverses for
  // chronological display.
  .get('/', async (c) => {
    const userId = c.get('userId')
    const parsed = listMessagesSchema.safeParse({
      limit: c.req.query('limit'),
    })
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400)
    }
    const { limit } = parsed.data

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit)

    return c.json(rows)
  })
  // multipart/form-data: { content: string, image?: File }
  // JSON is also accepted (Content-Type: application/json) for text-only
  // requests.
  .post('/', async (c) => {
    const userId = c.get('userId')

    const { content, image } = await readBody(c.req.raw)
    if (!content || content.length === 0) {
      return c.json({ error: 'content is required' }, 400)
    }
    if (content.length > 10_000) {
      return c.json({ error: 'content too long (max 10000 chars)' }, 400)
    }

    let imagePayload: { mediaType: string; base64: string } | null = null
    if (image) {
      if (!ALLOWED_IMAGE_TYPES.has(image.type)) {
        return c.json({ error: `unsupported image type: ${image.type}` }, 400)
      }
      const buf = await image.arrayBuffer()
      imagePayload = {
        mediaType: image.type,
        base64: Buffer.from(buf).toString('base64'),
      }
    }

    // Pull context BEFORE inserting the new user message — keeps the LLM
    // history clean (the current turn is added explicitly below). Then persist
    // the user message so it survives even if the LLM call fails.
    const ctx = await fetchChatContext(c, userId)

    const [userMsg] = await db
      .insert(chatMessages)
      .values({
        userId,
        role: 'user',
        content,
        kind: 'text',
        meta: imagePayload ? { hadImage: true, mediaType: imagePayload.mediaType } : null,
      })
      .returning()

    const messages: Anthropic.MessageParam[] = historyToMessages(ctx.history)
    messages.push(buildCurrentUserMessage(content, imagePayload))

    const aiMessages = await runToolLoop({
      userId,
      systemPrompt: buildSystemPrompt(ctx),
      messages,
    })

    return c.json({ user: userMsg!, ai: aiMessages }, 201)
  })

async function readBody(req: Request): Promise<{ content: string; image: File | null }> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const body = (await req.json().catch(() => null)) as { content?: unknown } | null
    return {
      content: typeof body?.content === 'string' ? body.content : '',
      image: null,
    }
  }
  // Default: treat as multipart/form-data.
  const form = await req.formData()
  const rawContent = form.get('content')
  const rawImage = form.get('image')
  return {
    content: typeof rawContent === 'string' ? rawContent : '',
    image: rawImage instanceof File && rawImage.size > 0 ? rawImage : null,
  }
}

async function fetchChatContext(c: Context<AuthEnv>, userId: string): Promise<ChatContext> {
  const today = clientToday(c)
  const lookback = new Date(Date.now() - MEAL_LOOKBACK_DAYS * 86_400_000)
  const [history, recentMeals, todaysGoalRows] = await Promise.all([
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(HISTORY_DEPTH),
    db
      .select()
      .from(meals)
      .where(and(eq(meals.userId, userId), gte(meals.timestamp, lookback)))
      .orderBy(desc(meals.timestamp)),
    db
      .select()
      .from(dailyGoals)
      .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, today)))
      .limit(1),
  ])
  return { today, history, recentMeals, todaysGoal: todaysGoalRows[0] }
}

// Maps DB rows → MessageParam, in chronological order. Crucially merges
// consecutive same-role rows into one message (Anthropic rejects adjacent
// same-role messages, and a single LLM turn can leave behind multiple `ai`
// rows: text + action card, etc.).
function historyToMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = []
  for (const m of [...history].reverse()) {
    if (!m.content) continue
    const role: 'user' | 'assistant' = m.role === 'ai' ? 'assistant' : 'user'
    const last = merged[merged.length - 1]
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      merged.push({ role, content: m.content })
    }
  }
  return merged
}

function buildCurrentUserMessage(
  content: string,
  image: { mediaType: string; base64: string } | null,
): Anthropic.MessageParam {
  if (!image) {
    return { role: 'user', content }
  }
  return {
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: image.base64,
        },
      },
      { type: 'text', text: content },
    ],
  }
}

// Drives the tool-use loop. On each iteration:
//   * call the model with the current message stack + tool definitions
//   * persist any text blocks
//   * for each tool_use, execute the tool server-side and:
//       - if it's a write tool, additionally log an action card
//   * feed all tool results back as a user-role message and loop
//   * stop on end_turn (or when no tool_use blocks were emitted)
async function runToolLoop(args: {
  userId: string
  systemPrompt: string
  messages: Anthropic.MessageParam[]
}): Promise<ChatMessage[]> {
  const { userId, systemPrompt } = args
  const messages = [...args.messages]
  const persisted: ChatMessage[] = []

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
      metadata: { user_id: userId },
    })

    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        const text = block.text.trim()
        if (!text) continue
        const [row] = await db
          .insert(chatMessages)
          .values({ userId, role: 'ai', content: text, kind: 'text' })
          .returning()
        if (row) persisted.push(row)
      } else if (block.type === 'tool_use') {
        const result = await executeTool(
          block.name as ToolName,
          (block.input ?? {}) as Record<string, unknown>,
          userId,
        )

        if (result.ok && isWriteTool(block.name)) {
          const card = await persistActionCard(userId, result, block.input)
          if (card) persisted.push(card)
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(toolResultPayload(result)),
          is_error: !result.ok,
        })
      }
    }

    if (toolResults.length === 0) break

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })

    if (response.stop_reason !== 'tool_use') break
  }

  return persisted
}

// What we feed back to Claude as the tool's result. For reads we pass through
// the data; for writes we pass the row(s) so Claude can reference them in
// follow-up text ("записал, осталось ~600 ккал").
function toolResultPayload(
  result: Awaited<ReturnType<typeof executeTool>>,
): Record<string, unknown> {
  if (!result.ok) return { ok: false, error: result.error }
  switch (result.kind) {
    case 'read':
      return { ok: true, data: result.data }
    case 'meal_added':
      return { ok: true, action: 'meal_added', meal: result.meal }
    case 'meal_updated':
      return { ok: true, action: 'meal_updated', meal: result.meal, before: result.before }
    case 'meal_removed':
      return { ok: true, action: 'meal_removed', meal: result.meal }
    case 'goal_set':
      return { ok: true, action: 'goal_set', goal: result.goal }
  }
}

// Persist a chat row that mirrors the write the LLM just performed. The iOS
// client renders this as a card describing what happened.
async function persistActionCard(
  userId: string,
  result: Awaited<ReturnType<typeof executeTool>>,
  rawInput: unknown,
): Promise<ChatMessage | undefined> {
  if (!result.ok) return undefined
  switch (result.kind) {
    case 'meal_added': {
      const m = result.meal
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          role: 'ai',
          kind: 'meal_added',
          content: `${m.foodName} — ${m.calories} kcal`,
          meta: { mealId: m.id, meal: serializeMeal(m) },
        })
        .returning()
      return row
    }
    case 'meal_updated': {
      const m = result.meal
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          role: 'ai',
          kind: 'meal_updated',
          content: `${m.foodName} → ${m.calories} kcal`,
          meta: {
            mealId: m.id,
            before: serializeMeal(result.before),
            after: serializeMeal(m),
            patch: rawInput,
          },
        })
        .returning()
      return row
    }
    case 'meal_removed': {
      const m = result.meal
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          role: 'ai',
          kind: 'meal_removed',
          content: `Removed: ${m.foodName} (${m.calories} kcal)`,
          meta: { mealId: m.id, meal: serializeMeal(m) },
        })
        .returning()
      return row
    }
    case 'goal_set': {
      const g = result.goal
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          role: 'ai',
          kind: 'goal_set',
          content: `${g.date} · ${g.calorieGoal} kcal · ${g.dayType}`,
          meta: { goalId: g.id, goal: serializeGoal(g) },
        })
        .returning()
      return row
    }
    case 'read':
      return undefined
  }
}

// Date columns come back as Date objects from drizzle; serialize to ISO so the
// JSON survives through chatMessages.meta cleanly.
function serializeMeal(m: Meal): Record<string, unknown> {
  return {
    id: m.id,
    timestamp: m.timestamp.toISOString(),
    meal: m.meal,
    emoji: m.emoji,
    foodName: m.foodName,
    calories: m.calories,
    protein: m.protein,
    carbs: m.carbs,
    fats: m.fats,
  }
}

function serializeGoal(g: Goal): Record<string, unknown> {
  return {
    id: g.id,
    date: g.date,
    dayType: g.dayType,
    calorieGoal: g.calorieGoal,
    proteinGGoal: g.proteinGGoal,
    carbsGGoal: g.carbsGGoal,
    fatGGoal: g.fatGGoal,
  }
}

// Returns YYYY-MM-DD in the user's local calendar, derived from the
// X-Client-TZ-Offset header (minutes east of UTC, matching iOS's
// TimeZone.current.secondsFromGMT() / 60). Falls back to UTC when the header
// is absent — direct curl calls keep working.
function clientToday(c: Context<AuthEnv>): string {
  const raw = c.req.header('X-Client-TZ-Offset')
  const offsetMin = raw !== undefined ? Number.parseInt(raw, 10) : 0
  const offset = Number.isFinite(offsetMin) ? offsetMin : 0
  const local = new Date(Date.now() + offset * 60_000)
  return local.toISOString().slice(0, 10)
}

function buildSystemPrompt(ctx: ChatContext): string {
  const { today, todaysGoal, recentMeals } = ctx

  const goalsLine = todaysGoal
    ? `Today (${today}) is a ${todaysGoal.dayType} day. Targets: ${todaysGoal.calorieGoal} kcal, ${todaysGoal.proteinGGoal}g protein, ${todaysGoal.carbsGGoal}g carbs, ${todaysGoal.fatGGoal}g fat.`
    : `Today is ${today}. No goal configured yet — call set_goal if the user asks for one.`

  const mealsBlock =
    recentMeals.length === 0
      ? 'No meals logged in the past month.'
      : `Recent meals (last ${MEAL_LOOKBACK_DAYS} days, most recent first):\n${recentMeals
          .slice(0, 25)
          .map((m) => {
            const when = m.timestamp.toISOString().slice(0, 16).replace('T', ' ')
            const emoji = m.emoji ? `${m.emoji} ` : ''
            return `  - ${when} [${m.meal}] ${emoji}${m.foodName} — ${m.calories} kcal (P${m.protein} / C${m.carbs} / F${m.fats})`
          })
          .join('\n')}`

  return [
    'You are a friendly nutrition assistant inside a calorie-tracking iOS app.',
    'Help the user log food, reflect on their intake, and stay on track. Be concise and practical.',
    '',
    `Today's date: ${today}`,
    '',
    'Tools:',
    '  * get_goal_for_day(date) / get_meals_for_day(date) — read user data. Each meal row includes its `id`.',
    '  * add_meal(...) — log a meal immediately. Use whenever the user expresses logging intent (text, photo, or both). Estimate macros conservatively.',
    '  * update_meal(id, ...) — edit an existing meal in place when the user corrects macros, name, or portion. Pass only fields that change.',
    '  * delete_meal(id) — remove a meal entirely (e.g. user did not eat it).',
    '  * set_goal(date, ...) — create or replace a daily nutrition goal.',
    '',
    'Guidance:',
    '  - Writes happen the moment you call the tool — there is no separate confirm step. The iOS app shows a card describing what changed.',
    '  - After a write, briefly acknowledge what you did and (when relevant) recap remaining macro budget. Reference SPECIFIC dishes from "Recent meals" when suggesting what to eat next ("твой творог", "та куриная грудка с гречкой") rather than generic advice.',
    '  - To correct a logged meal, prefer update_meal over delete + add_meal. If the user wants to swap one dish for a different one, use delete_meal then add_meal.',
    '  - When you need a meal id you do not have in context, call get_meals_for_day first.',
    '',
    goalsLine,
    '',
    mealsBlock,
  ].join('\n')
}
