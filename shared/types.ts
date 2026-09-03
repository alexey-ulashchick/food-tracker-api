// Wire shapes shared by the Hono API and the web client. Hand-written rather
// than inferred from drizzle for two reasons: the browser bundle must never
// pull in drizzle, and the JSON shape differs from the row type — drizzle
// returns Date objects that Hono serialises to ISO strings, which the types
// below already reflect.

/** KEEP IN SYNC with src/lib/dietDayClassifier.ts. Duplicated rather than
 *  imported so the browser bundle does not reach into server code. */
export type DietDayColor = 'gray' | 'blue' | 'green' | 'light_green' | 'yellow' | 'orange' | 'red'

export type DayTypeName = 'training' | 'rest'
export type MealTypeName = 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack'
export type ChatRole = 'user' | 'ai'

export type ChatKind =
  | 'text'
  | 'meal_added'
  | 'meal_removed'
  | 'meal_updated'
  | 'goal_set'
  | 'memory_added'
  | 'memory_updated'
  | 'memory_removed'
  | 'recommend'

export type Macros = {
  calories: number
  protein: number
  carbs: number
  fats: number
}

// ── Resource rows ─────────────────────────────────────────────────────────

export type ServerMeal = {
  id: string
  userId: string
  timestamp: string
  /** Minutes east of UTC where the meal was eaten. Null on legacy rows
   *  logged before the column existed. */
  tzOffsetMin: number | null
  meal: MealTypeName
  emoji: string | null
  foodName: string
  calories: number
  protein: number
  carbs: number
  fats: number
  /** The TS field is `updatedAt` but it maps to the SQL column `created_at`
   *  — a long-standing quirk of the meals table, mirrored in tests/init.sql. */
  updatedAt: string
  /** Server-computed YYYY-MM-DD in the TZ where the meal was eaten. Use this
   *  for every per-day bucketing — never re-derive it from `timestamp`, or a
   *  Moscow breakfast gets misfiled once the client is in another TZ. */
  localDate: string
}

export type ServerGoal = {
  id: string
  userId: string
  dayType: DayTypeName
  date: string
  calorieGoal: number
  proteinGGoal: number
  carbsGGoal: number
  fatGGoal: number
  updatedAt: string
}

export type ServerMemory = {
  id: string
  userId: string
  content: string
  createdAt: string
  updatedAt: string
}

export type ServerWeight = {
  id: string
  userId: string
  date: string
  kg: number
  source: string | null
  createdAt: string
}

export type ServerChatMessage = {
  id: string
  userId: string
  /** When the message belongs on the timeline. Distinct from `createdAt`:
   *  /chat/recommend staggers `timestamp` across a burst of inserts to keep
   *  the deck in best-first order after a reload. */
  timestamp: string
  role: ChatRole
  content: string
  kind: ChatKind
  /** Free-form jsonb; the shape depends on `kind`. See the *Meta types below. */
  meta: unknown
  /** Per-turn usage, stamped on the LAST ai row of a turn. Null everywhere else. */
  inputTokens: number | null
  outputTokens: number | null
  cacheCreationTokens: number | null
  cacheReadTokens: number | null
  costUsd: number | null
  createdAt: string
}

export type ServerDaySummary = {
  date: string
  color: DietDayColor
  title: string
  reason: string
  eaten: Macros
  goal: {
    dayType: DayTypeName
    calorieGoal: number
    proteinGGoal: number
    carbsGGoal: number
    fatGGoal: number
  } | null
}

// ── chat_messages.meta payloads, one per kind ─────────────────────────────
// Mirrors persistActionCard() in src/routes/chat.ts.

export type MealSnapshot = {
  id: string
  timestamp: string
  tzOffsetMin: number | null
  meal: MealTypeName
  emoji: string | null
  foodName: string
  calories: number
  protein: number
  carbs: number
  fats: number
}

export type GoalSnapshot = {
  id: string
  date: string
  dayType: DayTypeName
  calorieGoal: number
  proteinGGoal: number
  carbsGGoal: number
  fatGGoal: number
}

export type MemorySnapshot = {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

export type MealAddedMeta = { mealId: string; meal: MealSnapshot }
export type MealUpdatedMeta = { mealId: string; before: MealSnapshot; after: MealSnapshot }
export type MealRemovedMeta = { mealId: string; meal: MealSnapshot }
export type GoalSetMeta = { goalId: string; goal: GoalSnapshot }
export type MemoryAddedMeta = { memoryId: string; memory: MemorySnapshot }
export type MemoryUpdatedMeta = { memoryId: string; before: MemorySnapshot; after: MemorySnapshot }
export type MemoryRemovedMeta = { memoryId: string; memory: MemorySnapshot }

/** meta on a user row that carried a photo. `thumb` is a data: URL of the
 *  client-side downscale; the full-size image goes to Anthropic and is never
 *  persisted, so history replay depends entirely on this field. */
export type UserImageMeta = { hadImage: true; mediaType: string; thumb?: string }

// ── /chat/recommend ───────────────────────────────────────────────────────

export type RecommendationMacros = {
  calories: number
  protein: number
  fat: number
  carbs: number
}

export type RecommendationFood = {
  id: string
  displayName: string
  emoji: string | null
  calories: number
  protein: number
  fat: number
  carbs: number
}

export type RecommendationMeta = {
  currentColor: DietDayColor
  color: DietDayColor
  foods: RecommendationFood[]
  addedMacros: RecommendationMacros
  finalMacros: RecommendationMacros
}

export type RecommendError = { code: 'no_goal' | 'internal'; message: string; date?: string }

// ── Envelopes ─────────────────────────────────────────────────────────────

export type ChatPostResponse = { user: ServerChatMessage; ai: ServerChatMessage[] }
export type DeleteAck = { ok: boolean; id: string }
