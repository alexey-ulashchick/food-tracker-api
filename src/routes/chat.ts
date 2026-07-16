import type Anthropic from '@anthropic-ai/sdk'
import { and, desc, eq, gte } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { chatMessages, dailyGoals, meals, type memories } from '../db/schema.ts'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  type Usage,
  anthropic,
  priceUsage,
} from '../llm/anthropic.ts'
import { type ToolName, executeTool, isWriteTool, loadMemories, tools } from '../llm/tools.ts'
import {
  type Recommendation,
  generateRecommendations,
} from '../lib/recommend.ts'
import { mealLocalDate } from '../lib/mealLocalDate.ts'
import { type AuthEnv, auth } from '../middleware/auth.ts'

const HISTORY_DEPTH = 30
const MEAL_LOOKBACK_DAYS = 30
// Max model round-trips per user turn. Generous so bulk operations (e.g.
// setting goals for a whole month, or fanning out reads to find an old meal)
// can run to completion instead of dying mid-way. Each iteration can emit
// many tool_use blocks, so this is a safety ceiling, not the expected depth.
const MAX_TOOL_ITERATIONS = 20
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
})

type ChatMessage = typeof chatMessages.$inferSelect
type Meal = typeof meals.$inferSelect
type Goal = typeof dailyGoals.$inferSelect
type Memory = typeof memories.$inferSelect

type ChatContext = {
  today: string
  tzOffsetMin: number
  history: ChatMessage[]
  recentMeals: Meal[]
  todaysGoal: Goal | undefined
  memories: Memory[]
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

    const messages: Anthropic.MessageParam[] = historyToMessages(ctx.history, ctx.tzOffsetMin)
    messages.push(buildCurrentUserMessage(content, imagePayload))

    const aiMessages = await runToolLoop({
      userId,
      systemPrompt: buildSystemPrompt(ctx),
      messages,
      tzOffsetMin: ctx.tzOffsetMin,
      today: ctx.today,
    })

    return c.json({ user: userMsg!, ai: aiMessages }, 201)
  })
  // SSE stream of food-recommendation cards. The client hits this when the
  // user types "/recommend" in chat; the server is the only place that knows
  // the user's targets, today's intake, and the 30-day food history, so the
  // whole recommendation engine runs here and emits one card per achievable
  // color. No LLM involved — generation is deterministic.
  //
  // Event sequence:
  //   error      — daily goal missing for today (no recs possible); ends stream
  //   user       — the persisted "/recommend" chat row, so the client renders
  //                the user bubble for it
  //   recommend  — one event per achievable target color (green → light_green
  //                → yellow → orange), each carrying a persisted chat row with
  //                kind='recommend' and the full Recommendation payload in meta
  //   text       — fallback "nothing useful found" ai row when zero colors
  //                are achievable
  //   done       — closes the stream
  //
  // Every event's `data` is a JSON-encoded chat_messages row, so the client
  // can drop it straight into its message list using the same toLocal mapper
  // that handles non-streamed rows.
  .post('/recommend', async (c) => {
    const userId = c.get('userId')
    const tzOffsetMin = clientTzOffsetMin(c)
    const today = todayInOffset(tzOffsetMin)
    const userTag = userId.slice(0, 8)
    console.log(
      `[recommend] start user=${userTag} tz=${tzOffsetMin} today=${today}`,
    )

    return streamSSE(c, async (stream) => {
      try {
        const [goalRow] = await db
          .select()
          .from(dailyGoals)
          .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, today)))
          .limit(1)

        if (!goalRow) {
          console.log(`[recommend] no-goal user=${userTag} today=${today}`)
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              code: 'no_goal',
              message:
                'Сначала выстави цель на день: без цели рекомендация невозможна.',
              date: today,
            }),
          })
          return
        }
        console.log(
          `[recommend] goal user=${userTag} kcal=${goalRow.calorieGoal} p=${goalRow.proteinGGoal} c=${goalRow.carbsGGoal} f=${goalRow.fatGGoal}`,
        )

        // Persist the user's "/recommend" command so the chat history records
        // what triggered the cards that follow. Same shape as a normal user
        // text message — the client renders it as a regular bubble.
        const [userMsg] = await db
          .insert(chatMessages)
          .values({
            userId,
            role: 'user',
            content: '/recommend',
            kind: 'text',
          })
          .returning()
        if (userMsg) {
          await stream.writeSSE({ event: 'user', data: JSON.stringify(userMsg) })
        }

        // Today's intake (sum of meals whose local date is `today`). Same
        // boundaries the chat system prompt uses, so the recommendation and the
        // chat numbers stay consistent.
        const lookback = new Date(Date.now() - MEAL_LOOKBACK_DAYS * 86_400_000)
        const recentRows = await db
          .select()
          .from(meals)
          .where(and(eq(meals.userId, userId), gte(meals.timestamp, lookback)))
          .orderBy(desc(meals.timestamp))
        const todayMeals = recentRows.filter(
          (m) => mealLocalDate(m, tzOffsetMin) === today,
        )
        const current = sumMacros(todayMeals)
        console.log(
          `[recommend] inputs user=${userTag} history=${recentRows.length} today-meals=${todayMeals.length} current-kcal=${Math.round(current.calories)} current-p=${Math.round(current.protein)} current-f=${Math.round(current.fats)} current-c=${Math.round(current.carbs)}`,
        )

        const engineStart = performance.now()
        const engine = generateRecommendations({
          goal: goalRow,
          current: {
            calories: current.calories,
            protein: current.protein,
            fat: current.fats,
            carbs: current.carbs,
          },
          foodHistory: recentRows,
        })
        const engineMs = Math.round(performance.now() - engineStart)
        console.log(
          `[recommend] engine user=${userTag} current-color=${engine.current_color} recs=${engine.recommendations.length} colors=[${engine.recommendations.map((r) => r.color).join(',')}] took=${engineMs}ms`,
        )

        // Persist one chat_messages row per recommendation, then stream it. The
        // row order in DB matches the stream order (best fit first, …), so a
        // chat reload renders the cards in the same sequence the user saw
        // live. Stagger createdAt by the loop index so the chat-history
        // fetch (sorted by createdAt DESC) preserves best-first order even
        // when wall-clock resolution would otherwise collide on rapid inserts.
        const recommendBase = new Date()
        for (let i = 0; i < engine.recommendations.length; i++) {
          const rec = engine.recommendations[i]!
          const row = await persistRecommendationRow(userId, rec, recommendBase, i)
          if (row) {
            await stream.writeSSE({ event: 'recommend', data: JSON.stringify(row) })
          }
        }

        if (engine.recommendations.length === 0) {
          // Spec UI copy: when no target color is reachable, surface a single
          // friendly text line instead of leaving the chat empty.
          console.log(`[recommend] no-recs user=${userTag} — emitting fallback text`)
          const [textRow] = await db
            .insert(chatMessages)
            .values({
              userId,
              role: 'ai',
              kind: 'text',
              content:
                'Сегодня нет полезной комбинации еды для попадания в green/light_green/yellow/orange.',
            })
            .returning()
          if (textRow) {
            await stream.writeSSE({ event: 'text', data: JSON.stringify(textRow) })
          }
        }

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ count: engine.recommendations.length }),
        })
        console.log(`[recommend] done user=${userTag} emitted=${engine.recommendations.length}`)
      } catch (err) {
        // Hono's streamSSE swallows callback exceptions silently — log
        // and re-emit so the iOS client renders an error card instead of
        // staring at a typing dot that never resolves.
        const msg = err instanceof Error ? err.message : String(err)
        console.error(
          `[recommend] error user=${userTag}`,
          err instanceof Error ? err.stack : err,
        )
        try {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ code: 'internal', message: msg }),
          })
        } catch {
          // Stream already closed — nothing we can do.
        }
      }
    })
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
  const tzOffsetMin = clientTzOffsetMin(c)
  const today = todayInOffset(tzOffsetMin)
  const lookback = new Date(Date.now() - MEAL_LOOKBACK_DAYS * 86_400_000)
  const [history, recentMeals, todaysGoalRows, memoryRows] = await Promise.all([
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
    loadMemories(userId),
  ])
  return {
    today,
    tzOffsetMin,
    history,
    recentMeals,
    todaysGoal: todaysGoalRows[0],
    memories: memoryRows,
  }
}

// Maps DB rows → MessageParam, in chronological order. Crucially merges
// consecutive same-role rows into one message (Anthropic rejects adjacent
// same-role messages, and a single LLM turn can leave behind multiple `ai`
// rows: text + action card, etc.).
//
// When the local date changes between rows we prefix the first row of the
// new day with a "[Day boundary: <prev> → <new>]" marker. The model is told
// (in the system prompt) that numbers above a boundary describe a different
// day's budget, not today's. We keep the full history — "как вчера" /
// "как обычно" still works — without letting yesterday's recap masquerade
// as today's state.
function historyToMessages(history: ChatMessage[], tzOffsetMin: number): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = []
  let prevDate: string | null = null
  for (const m of [...history].reverse()) {
    if (!m.content) continue
    const localDate = rowLocalDate(m, tzOffsetMin)
    let content = m.content
    if (prevDate !== null && prevDate !== localDate) {
      content = `[Day boundary: ${prevDate} → ${localDate}]\n\n${content}`
    }
    prevDate = localDate

    const role: 'user' | 'assistant' = m.role === 'ai' ? 'assistant' : 'user'
    const last = merged[merged.length - 1]
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${content}`
    } else {
      merged.push({ role, content })
    }
  }
  return merged
}

function rowLocalDate(m: ChatMessage, offsetMin: number): string {
  return new Date(m.createdAt.getTime() + offsetMin * 60_000).toISOString().slice(0, 10)
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
  tzOffsetMin: number
  today: string
}): Promise<ChatMessage[]> {
  const { userId, systemPrompt, tzOffsetMin, today } = args
  const messages = [...args.messages]
  const persisted: ChatMessage[] = []
  const userTag = userId.slice(0, 8)
  // Per-turn usage accumulator. A single user turn can drive multiple
  // anthropic.messages.create calls (initial + post-tool recap). We sum the
  // usage and stamp the total on the last persisted ai row at the end so
  // the iOS chat surface can render one tooltip for the turn.
  const turnUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  }

  console.log(
    `[chat] turn-begin user=${userTag} tz=${tzOffsetMin} sys-chars=${systemPrompt.length} msgs=${messages.length}`,
  )

  // Set once the model produces a response with NO tool calls — i.e. it
  // decided the turn is complete on its own. If we instead fall out of the
  // loop with this still false, we hit the iteration ceiling mid-work and owe
  // the user a closing message (see the wrap-up call below).
  let finishedNaturally = false

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const startedAt = performance.now()
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
      metadata: { user_id: userId },
    })
    const ms = Math.round(performance.now() - startedAt)
    const blockSummary = summarizeBlocks(response.content)
    const callUsage = priceUsage(DEFAULT_MODEL, response.usage)
    turnUsage.inputTokens += callUsage.inputTokens
    turnUsage.outputTokens += callUsage.outputTokens
    turnUsage.cacheCreationTokens += callUsage.cacheCreationTokens
    turnUsage.cacheReadTokens += callUsage.cacheReadTokens
    turnUsage.costUsd += callUsage.costUsd
    console.log(
      `[chat] llm-call user=${userTag} iter=${iter} stop=${response.stop_reason} in=${response.usage.input_tokens} out=${response.usage.output_tokens} cost=$${callUsage.costUsd.toFixed(4)} blocks=${blockSummary} took=${ms}ms`,
    )

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let didWrite = false

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
        const inputPreview = previewInput(block.input)
        console.log(
          `[chat] tool-call user=${userTag} iter=${iter} name=${block.name} input=${inputPreview}`,
        )
        const toolStart = performance.now()
        const result = await executeTool(
          block.name as ToolName,
          (block.input ?? {}) as Record<string, unknown>,
          userId,
          { defaultTzOffsetMin: tzOffsetMin },
        )
        const toolMs = Math.round(performance.now() - toolStart)

        if (result.ok) {
          console.log(
            `[chat] tool-ok user=${userTag} name=${block.name} kind=${result.kind} took=${toolMs}ms`,
          )
        } else {
          console.warn(
            `[chat] tool-err user=${userTag} name=${block.name} took=${toolMs}ms err=${result.error}`,
          )
        }

        if (result.ok && isWriteTool(block.name)) {
          didWrite = true
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

    if (toolResults.length === 0) {
      // No tool calls this round → the model gave its final answer. Natural,
      // complete end of the turn.
      finishedNaturally = true
      break
    }

    // After any write in this iteration, refetch today's totals and tack
    // them onto every tool_result so the model sees the post-write budget
    // (no mental arithmetic, no stale numbers from history). Fetched once
    // per iteration — multiple writes in the same turn share the snapshot.
    if (didWrite) {
      const snapshot = await computeTodaysSnapshot(userId, today, tzOffsetMin)
      for (const tr of toolResults) {
        if (tr.is_error) continue
        const parsed = JSON.parse(tr.content as string) as Record<string, unknown>
        parsed.todaysTotals = snapshot
        tr.content = JSON.stringify(parsed)
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })

    // NB: we intentionally do NOT break on stop_reason !== 'tool_use'. A bulk
    // operation (e.g. 30 set_goal calls) can truncate at max_tokens partway
    // through the batch; breaking here would strand the rest of the work and
    // end the turn with no recap. The only natural terminator is "the model
    // emitted no tool calls" (handled above); everything else keeps looping
    // until that happens or we hit MAX_TOOL_ITERATIONS.
  }

  // If we fell out of the loop still mid-work (hit MAX_TOOL_ITERATIONS while
  // the model wanted to keep calling tools), it never got to write a closing
  // line — the client would see a stack of action cards and then silence. Do
  // one final tools-off turn so the user always gets an acknowledgement, and
  // so the model can say what's still outstanding and offer to continue.
  if (!finishedNaturally) {
    console.warn(
      `[chat] iteration-cap user=${userTag} iters=${MAX_TOOL_ITERATIONS} — forcing tools-off wrap-up`,
    )
    const wrapSystem = `${systemPrompt}\n\nSYSTEM NOTE: You have reached the tool-call limit for this turn, so tools are now disabled. Reply with ONE short line: summarise what you just did, and if the task is not fully finished, tell the user exactly what's left and that they can ask you to continue.`
    const wrap = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: wrapSystem,
      // No `tools` → the model cannot call anything and must produce text.
      messages,
      metadata: { user_id: userId },
    })
    const wrapUsage = priceUsage(DEFAULT_MODEL, wrap.usage)
    turnUsage.inputTokens += wrapUsage.inputTokens
    turnUsage.outputTokens += wrapUsage.outputTokens
    turnUsage.cacheCreationTokens += wrapUsage.cacheCreationTokens
    turnUsage.cacheReadTokens += wrapUsage.cacheReadTokens
    turnUsage.costUsd += wrapUsage.costUsd
    for (const block of wrap.content) {
      if (block.type !== 'text') continue
      const text = block.text.trim()
      if (!text) continue
      const [row] = await db
        .insert(chatMessages)
        .values({ userId, role: 'ai', content: text, kind: 'text' })
        .returning()
      if (row) persisted.push(row)
    }
  }

  // Stamp the per-turn usage on the LAST persisted ai row so the iOS surface
  // can show one cost tooltip for the turn. We update the in-memory copy too
  // so the response payload carries the same numbers iOS would otherwise see
  // only after a refetch.
  const last = persisted[persisted.length - 1]
  if (last) {
    const [updated] = await db
      .update(chatMessages)
      .set({
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
        cacheCreationTokens: turnUsage.cacheCreationTokens,
        cacheReadTokens: turnUsage.cacheReadTokens,
        costUsd: turnUsage.costUsd,
      })
      .where(eq(chatMessages.id, last.id))
      .returning()
    if (updated) persisted[persisted.length - 1] = updated
  }

  console.log(
    `[chat] turn-end user=${userTag} persisted=${persisted.length} cost=$${turnUsage.costUsd.toFixed(4)} in=${turnUsage.inputTokens} out=${turnUsage.outputTokens}`,
  )
  return persisted
}

function summarizeBlocks(blocks: Anthropic.ContentBlock[]): string {
  let text = 0
  const tools: string[] = []
  for (const b of blocks) {
    if (b.type === 'text') text++
    else if (b.type === 'tool_use') tools.push(b.name)
  }
  return `text:${text}${tools.length ? ` tool_use:${tools.join(',')}` : ''}`
}

// One-line preview of a tool's input — full JSON, but capped so a giant
// payload doesn't flood the logs. Sensitive PII shouldn't live here in the
// first place; macros/dates/uuids are fine to dump.
function previewInput(input: unknown): string {
  if (input === undefined || input === null) return '{}'
  const json = JSON.stringify(input)
  return json.length > 400 ? `${json.slice(0, 400)}…` : json
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
    case 'memory_added':
      return { ok: true, action: 'memory_added', memory: result.memory }
    case 'memory_updated':
      return {
        ok: true,
        action: 'memory_updated',
        memory: result.memory,
        before: result.before,
      }
    case 'memory_removed':
      return { ok: true, action: 'memory_removed', memory: result.memory }
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
    case 'memory_added': {
      const mem = result.memory
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          role: 'ai',
          kind: 'memory_added',
          content: mem.content,
          meta: { memoryId: mem.id, memory: serializeMemory(mem) },
        })
        .returning()
      return row
    }
    case 'memory_updated': {
      const mem = result.memory
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          role: 'ai',
          kind: 'memory_updated',
          content: mem.content,
          meta: {
            memoryId: mem.id,
            before: serializeMemory(result.before),
            after: serializeMemory(mem),
          },
        })
        .returning()
      return row
    }
    case 'memory_removed': {
      const mem = result.memory
      const [row] = await db
        .insert(chatMessages)
        .values({
          userId,
          role: 'ai',
          kind: 'memory_removed',
          content: mem.content,
          meta: { memoryId: mem.id, memory: serializeMemory(mem) },
        })
        .returning()
      return row
    }
    case 'read':
      return undefined
  }
}

// Persists a single Recommendation as a chat_messages row (kind='recommend')
// so it survives reloads and decodes through the iOS client's existing
// `meta` machinery. `content` carries a human-readable one-liner that powers
// fallbacks (copy-to-clipboard, push notifications) when the iOS card UI
// isn't available.
//
// `createdAtBase` and `index` together produce a deterministic, monotonic
// createdAt across the burst of inserts a single /chat/recommend turn
// fires. Without it, defaultNow() can stamp multiple rows with identical
// timestamps (each insert is its own transaction but the wall clock is
// coarse enough to collide on serverless Postgres), and the chat history
// fetch — which sorts by createdAt DESC — returns the deck in an
// unstable order. Staggering by 1ms per index keeps best-first order
// after a loadHistory reconcile.
async function persistRecommendationRow(
  userId: string,
  rec: Recommendation,
  createdAtBase: Date,
  index: number,
): Promise<ChatMessage | undefined> {
  const foodSummary =
    rec.foods.length === 0
      ? 'ничего не есть'
      : rec.foods.map((f) => f.displayName).join(', ')
  const stampedAt = new Date(createdAtBase.getTime() + index)
  const [row] = await db
    .insert(chatMessages)
    .values({
      userId,
      role: 'ai',
      kind: 'recommend',
      content: `${rec.color}: ${foodSummary}`,
      meta: rec as unknown as Record<string, unknown>,
      timestamp: stampedAt,
      createdAt: stampedAt,
    })
    .returning()
  return row
}

// Date columns come back as Date objects from drizzle; serialize to ISO so the
// JSON survives through chatMessages.meta cleanly.
function serializeMeal(m: Meal): Record<string, unknown> {
  return {
    id: m.id,
    timestamp: m.timestamp.toISOString(),
    tzOffsetMin: m.tzOffsetMin,
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

function serializeMemory(m: Memory): Record<string, unknown> {
  return {
    id: m.id,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

// Returns YYYY-MM-DD in the user's local calendar, derived from the
// X-Client-TZ-Offset header (minutes east of UTC, matching iOS's
// TimeZone.current.secondsFromGMT() / 60). Falls back to UTC when the header
// is absent — direct curl calls keep working.
function clientTzOffsetMin(c: Context<AuthEnv>): number {
  const raw = c.req.header('X-Client-TZ-Offset')
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function todayInOffset(offsetMin: number): string {
  return new Date(Date.now() + offsetMin * 60_000).toISOString().slice(0, 10)
}

// What calendar date a meal falls on uses the shared helper in
// src/lib/mealLocalDate.ts. Imported above.

type Totals = { calories: number; protein: number; carbs: number; fats: number }

function sumMacros(rows: Meal[]): Totals {
  return rows.reduce<Totals>(
    (acc, m) => ({
      calories: acc.calories + m.calories,
      protein: acc.protein + m.protein,
      carbs: acc.carbs + m.carbs,
      fats: acc.fats + m.fats,
    }),
    { calories: 0, protein: 0, carbs: 0, fats: 0 },
  )
}

// Refetches today's meals + goal, in the user's local TZ, and returns a
// compact { eaten, remaining } snapshot. Called after a write tool so the
// model sees the post-write state directly in tool_result instead of having
// to do mental arithmetic on top of stale numbers.
async function computeTodaysSnapshot(
  userId: string,
  today: string,
  tzOffsetMin: number,
): Promise<Record<string, unknown>> {
  const [goalRow] = await db
    .select()
    .from(dailyGoals)
    .where(and(eq(dailyGoals.userId, userId), eq(dailyGoals.date, today)))
    .limit(1)

  const lookback = new Date(Date.now() - 2 * 86_400_000)
  const recentRows = await db
    .select()
    .from(meals)
    .where(and(eq(meals.userId, userId), gte(meals.timestamp, lookback)))
  const todayRows = recentRows.filter((m) => mealLocalDate(m, tzOffsetMin) === today)
  const eaten = sumMacros(todayRows)

  if (!goalRow) {
    return { date: today, mealsLogged: todayRows.length, eaten }
  }
  return {
    date: today,
    dayType: goalRow.dayType,
    mealsLogged: todayRows.length,
    eaten,
    remaining: {
      calories: goalRow.calorieGoal - eaten.calories,
      protein: goalRow.proteinGGoal - eaten.protein,
      carbs: goalRow.carbsGGoal - eaten.carbs,
      fats: goalRow.fatGGoal - eaten.fats,
    },
  }
}

function fmt(n: number): string {
  return Math.round(n).toString()
}

function buildSystemPrompt(ctx: ChatContext): string {
  const { today, tzOffsetMin, todaysGoal, recentMeals, memories: mems } = ctx

  const todayMeals = recentMeals.filter((m) => mealLocalDate(m, tzOffsetMin) === today)
  const eaten = sumMacros(todayMeals)

  // Goal + eaten + remaining table. Keeps the model from having to call
  // get_meals_for_day(today) just to recap the budget — and gives it the
  // numbers it needs to make a recommendation in one turn.
  const todayBlock: string[] = []
  if (todaysGoal) {
    const remain = {
      calories: todaysGoal.calorieGoal - eaten.calories,
      protein: todaysGoal.proteinGGoal - eaten.protein,
      carbs: todaysGoal.carbsGGoal - eaten.carbs,
      fats: todaysGoal.fatGGoal - eaten.fats,
    }
    const overNote = remain.calories < 0 ? '  (over on calories)' : ''
    todayBlock.push(
      `Today is ${today} (${todaysGoal.dayType} day).`,
      `  Targets:   ${fmt(todaysGoal.calorieGoal)} kcal · ${fmt(todaysGoal.proteinGGoal)} P · ${fmt(todaysGoal.carbsGGoal)} C · ${fmt(todaysGoal.fatGGoal)} F`,
      `  Eaten:     ${fmt(eaten.calories)} kcal · ${fmt(eaten.protein)} P · ${fmt(eaten.carbs)} C · ${fmt(eaten.fats)} F  (${todayMeals.length} meal${todayMeals.length === 1 ? '' : 's'})`,
      `  Remaining: ${fmt(remain.calories)} kcal · ${fmt(remain.protein)} P · ${fmt(remain.carbs)} C · ${fmt(remain.fats)} F${overNote}`,
    )
  } else {
    todayBlock.push(
      `Today is ${today}. No goal configured yet — call set_goal if the user asks for one.`,
      `  Eaten today: ${fmt(eaten.calories)} kcal · ${fmt(eaten.protein)} P · ${fmt(eaten.carbs)} C · ${fmt(eaten.fats)} F  (${todayMeals.length} meal${todayMeals.length === 1 ? '' : 's'})`,
    )
  }

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

  // Memories block — long-lived facts/preferences/recipes the user explicitly
  // saved. Each line is `id: content` so the LLM can pass the id straight to
  // update_memory / delete_memory.
  const memoriesBlock =
    mems.length === 0
      ? 'No saved memories yet.'
      : `Memories (long-lived facts the user asked to remember; pass the id to update_memory / delete_memory):\n${mems
          .map((m) => `  - ${m.id}: ${m.content}`)
          .join('\n')}`

  return [
    'You are a friendly nutrition assistant inside a calorie-tracking iOS app.',
    'Help the user log food, reflect on their intake, and stay on track. Be concise and practical.',
    '',
    `Today's date: ${today}`,
    '',
    'Tools:',
    '  * get_goal_for_day(date) / get_meals_for_day(date) — read user data. Each meal row includes its `id`.',
    '  * list_meals(endDate?, days?) — page through the meal history (default 5 days per page, newest first). Use it to browse what the user actually logged and find a past dish YOURSELF when you do not know its exact name or date; page back with the returned `olderThan` until you find a match or `hasOlder` is false.',
    '  * add_meal(...) — log a meal immediately. Use whenever the user expresses logging intent (text, photo, or both). Estimate macros conservatively.',
    '  * update_meal(id, ...) — edit an existing meal in place when the user corrects macros, name, or portion. Pass only fields that change.',
    '  * delete_meal(id) — remove a meal entirely (e.g. user did not eat it).',
    '  * set_goal(date, ...) — create or replace a daily nutrition goal.',
    '  * add_memory(content) / update_memory(id, content) / delete_memory(id) — manage long-lived facts the user asks to remember (preferences, allergies, recipes, recurring dishes, routines).',
    '',
    'Guidance:',
    '  - Writes happen the moment you call the tool — there is no separate confirm step. The iOS app shows a card describing what changed.',
    '  - NEVER reply with just a promise to act ("сейчас поищу", "начинаю устанавливать", "секунду", "let me check") and then stop. That ends your turn and the user gets no result. If the task needs tools, CALL them in THIS SAME turn; only send plain text once the work is done or when no tool is needed.',
    '  - Bulk requests (e.g. "выставь цели на 30 дней", "залогируй весь день") — issue ALL the required tool calls, not just the first few. You may emit many tool_use blocks in one turn and keep going across turns; do not stop until every day/item is handled. When everything is done, send ONE short summary line.',
    '  - Macro/calorie consistency (ALWAYS): any macros you propose or edit MUST reconcile with the Atwater formula — protein*4 + carbs*4 + fats*9 must equal the `calories` you pass (within ~5% for rounding). Before every add_meal / update_meal call, compute protein*4 + carbs*4 + fats*9 and adjust the numbers until they agree. Never emit macros whose implied energy contradicts `calories`. When editing macros with update_meal, pass calories AND all three macros together so the set stays balanced.',
    '  - The "Today" block below is the ONLY source of truth for today\'s eaten / remaining macros. Numbers in conversation history (yesterday\'s recaps, "осталось 0 ккал" from a previous day) describe THAT day\'s budget — not today\'s.',
    '  - Watch for `[Day boundary: <prev> → <new>]` markers in the conversation: every recap, suggestion, and budget number ABOVE a boundary belongs to a different day and is stale for today\'s budget. You can still reference past meals or preferences ("как вчера", "как обычно") — just don\'t carry the budget across.',
    '  - After a write tool, the tool_result includes a `todaysTotals` snapshot — trust it over your own arithmetic.',
    '  - When suggesting what to eat next, name SPECIFIC dishes from "Recent meals" ("твой творог", "та куриная грудка с гречкой") rather than generic advice.',
    '  - To correct a logged meal, prefer update_meal over delete + add_meal. If the user wants to swap one dish for a different one, use delete_meal then add_meal.',
    "  - Only call get_meals_for_day for a date OTHER than today, or when you need a meal id you don't already have in context.",
    '  - The "Recent meals" block below lists only the 25 most recent meals — it is NOT the full history. When the user refers to an older dish, or to something "похожее"/"как обычно" without naming it exactly, browse the real log with list_meals (paging back page by page) and judge which entries are similar yourself — do NOT assume it isn\'t there and do NOT expect a name-search.',
    '',
    'Memory guidance:',
    '  - Call add_memory ONLY when the user explicitly asks you to remember something ("запомни", "обычно я", "это важно", "у меня аллергия на …"), names a recurring dish or recipe, or shares a long-term goal/routine. Do NOT memorize today\'s meals (that\'s what add_meal is for) or arbitrary chatter.',
    '  - Each memory is one short sentence. Structure it like "Allergy: lactose", "Любимый завтрак: овсянка с бананом", "Тренировки: пн/ср/пт утром".',
    '  - Use update_memory when the user refines an existing memory (id is in the Memories block below). Use delete_memory when the user asks to forget something.',
    '  - Reference saved memories naturally in your replies — e.g. respect allergies when suggesting dishes, recall a favourite breakfast when asked for ideas.',
    '',
    'Recap text after a write tool:',
    '  - The iOS card already shows what changed (dish name, kcal, macros, or memory text). DO NOT repeat any of that in the text.',
    '  - Just ONE short line: a single-word acknowledgement + remaining budget or food suggestion for today',
    '',
    ...todayBlock,
    '',
    memoriesBlock,
    '',
    mealsBlock,
  ].join('\n')
}
