import type Anthropic from '@anthropic-ai/sdk'
import { and, desc, eq, gte } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { chatMessages, dailyGoals, meals } from '../db/schema.ts'
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, anthropic } from '../llm/anthropic.ts'
import { type ToolName, executeReadTool, tools } from '../llm/tools.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

const HISTORY_DEPTH = 30
const MEAL_LOOKBACK_DAYS = 30
const MAX_TOOL_ITERATIONS = 5
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

// Read-only subset of tools — used for the post-accept analysis turn so the
// LLM can recap budget but cannot accidentally spawn a fresh card.
const READ_ONLY_TOOLS = tools.filter((t) => t.name.startsWith('get_'))

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
})

const confirmSchema = z.object({
  chatMessageId: z.string().uuid(),
  accepted: z.boolean(),
  note: z.string().max(500).optional(),
})

// Validation for the meta blob the LLM stuffed into a food_card. The card
// originates from Claude, so it MIGHT not match the schema — we re-validate
// before writing to meals.
const foodCardMetaSchema = z.object({
  meal: z.enum(['Breakfast', 'Lunch', 'Dinner', 'Snack']),
  emoji: z.string().nullish(),
  foodName: z.string().min(1),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative(),
  fats: z.number().nonnegative(),
  timestamp: z.string().datetime().optional(),
})

const goalCardMetaSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayType: z.enum(['training', 'rest']),
  calorieGoal: z.number().positive(),
  proteinGGoal: z.number().nonnegative(),
  carbsGGoal: z.number().nonnegative(),
  fatGGoal: z.number().nonnegative(),
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

const POST_ACCEPT_HINT = [
  'This turn was triggered by the user accepting and logging a meal. The just-logged meal is the most recent row in "Recent meals" above.',
  'Reply in 2-3 short, friendly sentences. Tone: conversational nutrition coach, not a clinical recap.',
  '  1. Briefly acknowledge what was logged ("отлично", "записал", "огонь" — match the user\'s language).',
  "  2. Recap remaining macro budget — calories AND whichever macro is furthest from goal right now. Use concrete numbers, e.g. \"осталось ~600 ккал и 30g белка\".",
  "  3. Either ask what the user plans to eat next, OR — better — name a SPECIFIC dish from their past week that would close the remaining gap, picking from the names you see in 'Recent meals' above. Reference it concretely (\"твой творог\", \"вчерашний салат с тунцом\", \"та куриная грудка с гречкой\") — concrete names from history beat generic suggestions like \"protein source\".",
  'You may do both: name the specific past dish AND ask if they want it tonight.',
  'Do NOT call propose_meal here — stay in plain chat text. The user will explicitly ask if they want to log the suggestion.',
].join('\n')

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
  // Confirm or reject a card the LLM proposed (food_card or goal_card).
  // Body: { chatMessageId, accepted, note? }
  //   * food_card + accepted=true:  writes meals row, inserts confirm,
  //                                 runs LLM analysis with read-only tools.
  //   * food_card + accepted=false: inserts confirm only.
  //   * goal_card + accepted=true:  upserts daily_goals, inserts confirm.
  //   * goal_card + accepted=false: inserts confirm only.
  .post('/confirm', async (c) => {
    const userId = c.get('userId')

    const json = (await c.req.json().catch(() => null)) as unknown
    const parsed = confirmSchema.safeParse(json)
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400)
    }
    const { chatMessageId, accepted, note } = parsed.data

    const [card] = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, chatMessageId), eq(chatMessages.userId, userId)))
      .limit(1)

    if (!card) {
      return c.json({ error: 'card not found' }, 404)
    }
    if (card.kind !== 'food_card' && card.kind !== 'goal_card') {
      return c.json({ error: `not a confirmable card (kind=${card.kind})` }, 400)
    }

    if (card.kind === 'food_card') {
      return handleFoodCard(c, { userId, card, accepted, note })
    }
    return handleGoalCard(c, { userId, card, accepted, note })
  })

async function handleFoodCard(
  c: Context<AuthEnv>,
  args: { userId: string; card: ChatMessage; accepted: boolean; note?: string },
) {
  const { userId, card, accepted, note } = args

  if (!accepted) {
    const [confirm] = await db
      .insert(chatMessages)
      .values({
        userId,
        role: 'user',
        content: rejectContent(describeMealProposal(card.meta), note),
        kind: 'confirm',
        meta: { accepted: false, ref: card.id, note: note ?? null },
      })
      .returning()
    return c.json({ confirm: confirm!, ai: [] as ChatMessage[] }, 201)
  }

  const metaParsed = foodCardMetaSchema.safeParse(card.meta)
  if (!metaParsed.success) {
    return c.json({ error: 'food_card meta is malformed', detail: metaParsed.error.flatten() }, 422)
  }
  const m = metaParsed.data

  const [meal] = await db
    .insert(meals)
    .values({
      userId,
      timestamp: m.timestamp ? new Date(m.timestamp) : undefined,
      meal: m.meal,
      emoji: m.emoji ?? null,
      foodName: m.foodName,
      calories: m.calories,
      protein: m.protein,
      carbs: m.carbs,
      fats: m.fats,
    })
    .returning()

  const [confirm] = await db
    .insert(chatMessages)
    .values({
      userId,
      role: 'user',
      content: acceptContent(describeMealProposal(card.meta), note),
      kind: 'confirm',
      meta: { accepted: true, ref: card.id, mealId: meal!.id, note: note ?? null },
    })
    .returning()

  // Re-fetch context so the just-inserted meal and confirm row are visible to
  // the LLM. The latest history row is the user-side confirm — it acts as the
  // "trigger" message naturally.
  const ctx = await fetchChatContext(c, userId)
  const aiMessages = await runToolLoop({
    userId,
    systemPrompt: buildSystemPrompt(ctx, POST_ACCEPT_HINT),
    messages: historyToMessages(ctx.history),
    availableTools: READ_ONLY_TOOLS,
  })

  return c.json({ confirm: confirm!, ai: aiMessages, meal: meal! }, 201)
}

async function handleGoalCard(
  c: Context<AuthEnv>,
  args: { userId: string; card: ChatMessage; accepted: boolean; note?: string },
) {
  const { userId, card, accepted, note } = args

  if (!accepted) {
    const [confirm] = await db
      .insert(chatMessages)
      .values({
        userId,
        role: 'user',
        content: rejectContent(describeGoalProposal(card.meta), note),
        kind: 'confirm',
        meta: { accepted: false, ref: card.id, note: note ?? null },
      })
      .returning()
    return c.json({ confirm: confirm!, ai: [] as ChatMessage[] }, 201)
  }

  const metaParsed = goalCardMetaSchema.safeParse(card.meta)
  if (!metaParsed.success) {
    return c.json({ error: 'goal_card meta is malformed', detail: metaParsed.error.flatten() }, 422)
  }
  const g = metaParsed.data

  const [goal] = await db
    .insert(dailyGoals)
    .values({ userId, ...g })
    .onConflictDoUpdate({
      target: [dailyGoals.userId, dailyGoals.date],
      set: {
        dayType: g.dayType,
        calorieGoal: g.calorieGoal,
        proteinGGoal: g.proteinGGoal,
        carbsGGoal: g.carbsGGoal,
        fatGGoal: g.fatGGoal,
        updatedAt: new Date(),
      },
    })
    .returning()

  const [confirm] = await db
    .insert(chatMessages)
    .values({
      userId,
      role: 'user',
      content: acceptContent(describeGoalProposal(card.meta), note),
      kind: 'confirm',
      meta: { accepted: true, ref: card.id, goalId: goal!.id, note: note ?? null },
    })
    .returning()

  return c.json({ confirm: confirm!, ai: [] as ChatMessage[], goal: goal! }, 201)
}

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
// rows: text + food_card, etc.).
function historyToMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = []
  for (const m of [...history].reverse()) {
    if (m.kind === 'typing') continue
    if (!m.content || m.content === '(no response)') continue
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
//   * persist any text / proposal cards in the order they appeared
//   * if a propose_* tool was used, STOP — the card is the response, the
//     conversation now waits for the user (accept / reject / clarify)
//   * otherwise, if read tools were called, feed their results back and loop
//   * otherwise (plain text, end_turn) we're done
async function runToolLoop(args: {
  userId: string
  systemPrompt: string
  messages: Anthropic.MessageParam[]
  availableTools?: Anthropic.Tool[]
}): Promise<ChatMessage[]> {
  const { userId, systemPrompt, availableTools = tools } = args
  const messages = [...args.messages]
  const persisted: ChatMessage[] = []

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      tools: availableTools,
      messages,
      metadata: { user_id: userId },
    })

    let proposalMade = false
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
        if (block.name === 'propose_meal') {
          const [row] = await db
            .insert(chatMessages)
            .values({
              userId,
              role: 'ai',
              content: describeMealProposal(block.input),
              kind: 'food_card',
              meta: block.input as Record<string, unknown>,
            })
            .returning()
          if (row) persisted.push(row)
          proposalMade = true
        } else if (block.name === 'propose_goal') {
          const [row] = await db
            .insert(chatMessages)
            .values({
              userId,
              role: 'ai',
              content: describeGoalProposal(block.input),
              kind: 'goal_card',
              meta: block.input as Record<string, unknown>,
            })
            .returning()
          if (row) persisted.push(row)
          proposalMade = true
        }
      }
    }

    if (proposalMade) break
    if (response.stop_reason !== 'tool_use') break

    messages.push({ role: 'assistant', content: response.content })
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const result = await executeReadTool(
        block.name as ToolName,
        (block.input ?? {}) as Record<string, unknown>,
        userId,
      )
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      })
    }
    if (toolResults.length === 0) break
    messages.push({ role: 'user', content: toolResults })
  }

  return persisted
}

function describeMealProposal(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const name = typeof i.foodName === 'string' ? i.foodName : 'Meal'
  const cal = typeof i.calories === 'number' ? `${i.calories} kcal` : ''
  return cal ? `${name} — ${cal}` : name
}

function describeGoalProposal(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const date = typeof i.date === 'string' ? i.date : ''
  const cal = typeof i.calorieGoal === 'number' ? `${i.calorieGoal} kcal` : ''
  return [date, cal].filter(Boolean).join(' · ') || 'Goal proposal'
}

function acceptContent(summary: string, note: string | undefined): string {
  return note ? `✅ ${summary}\n— ${note}` : `✅ ${summary}`
}

function rejectContent(summary: string, note: string | undefined): string {
  return note ? `✗ ${summary}\n— ${note}` : `✗ ${summary}`
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

function buildSystemPrompt(ctx: ChatContext, hint?: string): string {
  const { today, todaysGoal, recentMeals } = ctx

  const goalsLine = todaysGoal
    ? `Today (${today}) is a ${todaysGoal.dayType} day. Targets: ${todaysGoal.calorieGoal} kcal, ${todaysGoal.proteinGGoal}g protein, ${todaysGoal.carbsGGoal}g carbs, ${todaysGoal.fatGGoal}g fat.`
    : `Today is ${today}. No goal configured for today yet — propose one with propose_goal if the user asks.`

  const mealsBlock =
    recentMeals.length === 0
      ? 'No meals logged in the past week.'
      : `Recent meals (last ${MEAL_LOOKBACK_DAYS} days, most recent first):\n${recentMeals
          .slice(0, 25)
          .map((m) => {
            const when = m.timestamp.toISOString().slice(0, 16).replace('T', ' ')
            const emoji = m.emoji ? `${m.emoji} ` : ''
            return `  - ${when} [${m.meal}] ${emoji}${m.foodName} — ${m.calories} kcal (P${m.protein} / C${m.carbs} / F${m.fats})`
          })
          .join('\n')}`

  const lines = [
    'You are a friendly nutrition assistant inside a calorie-tracking iOS app.',
    'Help the user log food, reflect on their intake, and stay on track. Be concise and practical.',
    '',
    `Today's date: ${today}`,
    '',
    'Tools:',
    '  * get_goal_for_day(date) and get_meals_for_day(date) read user data — call them when you need facts you do not already have.',
    '  * propose_meal(...) and propose_goal(...) produce a draft card; the user reviews and accepts/rejects it in the app. The card IS your response.',
    '  * For food-logging intent (text, photo, or both), call propose_meal directly. A short comment BEFORE the tool call is fine ("вижу куриную грудку с макаронами"); do NOT add closing text after it ("нажми подтвердить", "проверь и подтверди" — never).',
    '  * If the user rejected a previous card or asks to refine numbers, treat it as a new proposal: ask one clarifying question OR emit a corrected propose_meal. Do not chain "tap confirm" pleas.',
    '',
    goalsLine,
    '',
    mealsBlock,
  ]

  if (hint) {
    lines.push('', '---', hint)
  }

  return lines.join('\n')
}
