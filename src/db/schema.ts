import {
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { GoalBreakdown } from '../../shared/types.ts'

export const dayTypeEnum = pgEnum('day_type', ['training', 'rest'])
export const mealTypeEnum = pgEnum('meal_type', ['Breakfast', 'Lunch', 'Dinner', 'Snack'])
export const chatRoleEnum = pgEnum('chat_role', ['user', 'ai'])
export const chatKindEnum = pgEnum('chat_kind', [
  'text',
  // Action cards: the LLM executed a write tool and we logged what happened.
  'meal_added',
  'meal_removed',
  'meal_updated',
  'goal_set',
  'memory_added',
  'memory_updated',
  'memory_removed',
  // /chat/recommend output: one row per achievable diet-day color, plus the
  // "current color" row that opens the reply. `meta` carries the structured
  // payload (color, foods[], added_macros, final_macros) — see
  // src/routes/chat.ts for the exact shape.
  'recommend',
])

// Where a day's goal came from. `manual` is anything a human asked for —
// set_goal from chat, PATCH /goals, the MCP tool. `auto` is computed by
// POST /training/sync from the base expenditure plus the planned session.
//
// The distinction is not cosmetic: the sync's upsert carries
// `WHERE source = 'auto'`, so a manual goal is structurally un-overwritable
// rather than protected by a convention three separate writers must remember.
export const goalSourceEnum = pgEnum('goal_source', ['manual', 'auto'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// One row per user. Everything is nullable because "not configured yet" has to
// be expressible: an unset base expenditure means no automatic goal at all,
// which is different from a base of zero.
//
// user_id is the primary key rather than a surrogate id with a unique index —
// there is exactly one settings row per user, and a separate id would only
// make a second one possible.
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Daily expenditure before any training, kcal. */
  baseCalories: real('base_calories'),
  /** Fixed protein and fat; carbohydrate is whatever calories are left over. */
  proteinG: real('protein_g'),
  fatG: real('fat_g'),
  intervalsAthleteId: text('intervals_athlete_id'),
  // Never leaves the server. GET /settings returns the last four characters as
  // `intervalsKeyHint` instead, enough to tell two keys apart and not enough
  // to use one. Stored in the clear: encrypting it would need a key in Fly
  // secrets, which is the same secret one level down.
  intervalsApiKey: text('intervals_api_key'),
  intervalsSyncedAt: timestamp('intervals_synced_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const dailyGoals = pgTable(
  'daily_goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dayType: dayTypeEnum('day_type').notNull(),
    date: date('date').notNull(),
    calorieGoal: real('calorie_goal').notNull(),
    proteinGGoal: real('protein_g_goal').notNull(),
    carbsGGoal: real('carbs_g_goal').notNull(),
    fatGGoal: real('fat_g_goal').notNull(),
    source: goalSourceEnum('source').notNull().default('manual'),
    // What an `auto` row was computed from, frozen at the time it was written:
    // the base, the strength bonus, and one entry per planned ride. Null on
    // manual rows. A snapshot rather than something recomputed on read, for
    // the same reason /day-summary ships `eaten` next to its verdict — so the
    // screen can show the number AND its derivation without a second request.
    breakdown: jsonb('breakdown').$type<GoalBreakdown>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateUq: uniqueIndex('daily_goals_user_date_uq').on(t.userId, t.date),
  }),
)

export const meals = pgTable(
  'meals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // When the food was eaten. SQL column is "timestamp" (Postgres handles
    // it as an identifier when quoted, which Drizzle does automatically).
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    // The local timezone offset (minutes east of UTC) at the place where the
    // meal was eaten. Lets us bucket history by *meal-local* date even after
    // the user travels to a different TZ. Nullable so legacy rows survive
    // without a backfill — readers fall back to the request's current offset.
    tzOffsetMin: integer('tz_offset_min'),
    meal: mealTypeEnum('meal').notNull(),
    emoji: text('emoji'),
    foodName: text('food_name').notNull(),
    calories: real('calories').notNull(),
    protein: real('protein').notNull().default(0),
    carbs: real('carbs').notNull().default(0),
    fats: real('fats').notNull().default(0),
    updatedAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Range queries by user are the primary access pattern:
    //   WHERE user_id = $1 AND timestamp BETWEEN $2 AND $3
    // Composite index with user_id first lets the planner seek straight to a
    // user's slice and walk timestamps in order.
    userTimestampIdx: index('meals_user_timestamp_idx').on(t.userId, t.timestamp),
  }),
)

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    role: chatRoleEnum('role').notNull(),
    content: text('content').notNull(),
    kind: chatKindEnum('kind').notNull().default('text'),
    meta: jsonb('meta'),
    // Per-turn usage. Stamped on the LAST ai row produced by a single user
    // turn (a turn can fire multiple LLM calls — initial + post-tool recap)
    // so the chat surface can show one tooltip "$0.0042 · 612→184 tok"
    // above that row. Null on every other row, including all 'user' rows.
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    // USD, stored as a float — precision is fine for these magnitudes.
    costUsd: real('cost_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Range queries by user are the primary access pattern:
    //   WHERE user_id = $1 AND timestamp BETWEEN $2 AND $3
    // Composite index with user_id first lets the planner seek straight to a
    // user's slice and walk timestamps in order.
    userTimestampIdx: index('chat_user_timestamp_idx').on(t.userId, t.timestamp),
  }),
)

// Long-lived facts/preferences/recipes the user explicitly asked the LLM to
// remember. Each row is a single short sentence in free text; the LLM
// structures it ("Allergy: lactose", "Preferred breakfast: oatmeal with
// banana"). Loaded into the system prompt on every chat turn — bound is
// soft, controlled by the chat route.
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('memories_user_idx').on(t.userId, t.updatedAt),
  }),
)

// Body weight, one row per calendar day. There is no in-app entry UI: the
// user's own sync script POSTs batches to /weights and the web client only
// reads, so the unique (user_id, date) index is what makes a re-run of that
// script an upsert instead of a pile of duplicates.
export const weights = pgTable(
  'weights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    kg: real('kg').notNull(),
    // Free-text provenance ("apple-health", "manual", a scale model, …).
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateUq: uniqueIndex('weights_user_date_uq').on(t.userId, t.date),
  }),
)

// Long-lived bearer credentials for the MCP endpoint, used by clients that// can't inject a custom X-User-Id header (mobile Claude). Token is the PK and
// is shipped in the URL path (POST /mcp/:token) — treat the row like a
// password. `revokedAt` lets us kill a token without deleting it (audit).
export const apiTokens = pgTable(
  'api_tokens',
  {
    token: text('token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('api_tokens_user_idx').on(t.userId),
  }),
)
