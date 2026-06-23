-- Mirror of src/db/schema.ts. Run inside a per-process test schema (search_path
-- set in tests/setup.ts) — references stay unqualified on purpose.
-- Keep this file in lockstep with schema.ts; integration tests will fail loudly
-- if drift creeps in.

CREATE TYPE day_type AS ENUM ('training', 'rest');
CREATE TYPE meal_type AS ENUM ('Breakfast', 'Lunch', 'Dinner', 'Snack');
CREATE TYPE chat_role AS ENUM ('user', 'ai');
CREATE TYPE chat_kind AS ENUM ('text', 'meal_added', 'meal_removed', 'meal_updated', 'goal_set', 'memory_added', 'memory_updated', 'memory_removed');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_type day_type NOT NULL,
  date date NOT NULL,
  calorie_goal real NOT NULL,
  protein_g_goal real NOT NULL,
  carbs_g_goal real NOT NULL,
  fat_g_goal real NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX daily_goals_user_date_uq ON daily_goals (user_id, date);

CREATE TABLE meals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timestamp timestamptz NOT NULL DEFAULT now(),
  tz_offset_min integer,
  meal meal_type NOT NULL,
  emoji text,
  food_name text NOT NULL,
  calories real NOT NULL,
  protein real NOT NULL DEFAULT 0,
  carbs real NOT NULL DEFAULT 0,
  fats real NOT NULL DEFAULT 0,
  -- schema.ts maps `updatedAt` → column `created_at`. Preserved verbatim.
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meals_user_timestamp_idx ON meals (user_id, timestamp);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timestamp timestamptz NOT NULL DEFAULT now(),
  role chat_role NOT NULL,
  content text NOT NULL,
  kind chat_kind NOT NULL DEFAULT 'text',
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_user_timestamp_idx ON chat_messages (user_id, timestamp);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_user_idx ON memories (user_id, updated_at);

CREATE TABLE api_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);
