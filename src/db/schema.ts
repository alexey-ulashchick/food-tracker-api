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
])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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

// Long-lived bearer credentials for the MCP endpoint, used by clients that
// can't inject a custom X-User-Id header (mobile Claude). Token is the PK and
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
