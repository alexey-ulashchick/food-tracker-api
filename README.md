# Food Tracker API

Backend service for the Food Tracker iOS app. Stores user data (meals, goals, chat history) in Postgres and proxies LLM calls to Anthropic Claude.

## Stack

- **Bun** runtime + TypeScript
- **Hono** web framework (serving via `Bun.serve`)
- **Drizzle ORM** + **postgres.js** driver
- **Postgres 16** — locally via `docker-compose`, or remote via [Neon](https://neon.tech) (free tier)
- **Anthropic Claude** via `@anthropic-ai/sdk`
- **Zod** for env + request validation
- **Biome** for lint + format

## Quick start

Requirements: Bun 1.1+, Docker (only if you want a local DB).

```bash
docker compose up -d                   # Postgres at localhost:5432
cp .env.example .env                   # add your ANTHROPIC_API_KEY
bun install
bun run db:push                        # apply schema (no migrations yet)
bun run dev                            # server at http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

## Database — local vs Neon

Two ready-made backends, controlled by which env file is in play:

- `.env` — defaults to local docker (`postgres://food:food@localhost:5432/food`). Used by every plain `bun run <name>` command.
- `.env.neon` — Neon connection string (`postgresql://…@…neon.tech/neondb?sslmode=require`). Used only by the `*:neon` script variants.

Both files are gitignored (`.gitignore` excludes `.env*` except `.env.example`). Rotate the Neon credential via the Neon dashboard if `.env.neon` ever leaks.

### How the override works

`bun --env-file=.env.neon` layers the Neon URL on top of `.env`'s defaults — but Bun won't override values already set in `process.env`. The wrapper `env -u DATABASE_URL …` clears the parent-process value first, so the child Bun starts clean and `--env-file` wins. This pattern composes with any sub-script — that's why `db:push:neon`, `import:md:neon`, etc. exist in symmetric pairs.

## Scripts

Plain commands target the local DB (`.env`); the `*:neon` variants override `DATABASE_URL` from `.env.neon`.

| Command | Effect |
|---|---|
| `bun run dev` / `bun run dev:neon` | Start server with hot-reload (`bun --hot`) |
| `bun run start` | Start server without watch (used in prod / Docker) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome check |
| `bun run format` | Biome format --write |
| `bun run db:push` / `bun run db:push:neon` | Push Drizzle schema directly to DB |
| `bun run db:studio` / `bun run db:studio:neon` | Open Drizzle Studio (DB browser at localhost:4983) |
| `bun run import:md [dir]` / `bun run import:md:neon [dir]` | Import food-diary markdown files for the test user (default `~/Downloads`) |
| `bun test` | Run tests (uses local docker by default) |

## Importing food-diary markdown

`scripts/import-md.ts` ingests daily markdown files and writes them into `daily_goals` + `meals` for the hard-coded test user (`11111111-1111-1111-1111-111111111111`).

```bash
bun run import:md                  # reads ~/Downloads/2026-*.md → local DB
bun run import:md ~/some/dir       # any other directory
bun run import:md:neon             # same, but writes to Neon
```

Behaviour:

- **File matcher**: `^\d{4}-\d{2}-\d{2}.*\.md$` (e.g. `2026-06-10.md`, `2026-05-11_пн.md`).
- **Goals** parsed from `## Цели` / `## Цели по питанию` table or inline `**Цель:** X ккал / Y г Б / Z г Ж / W г У`. If only `Ккал`/`Белок` are present, fat & carbs default to 60 g / 150 g. Upserted on `(userId, date)`.
- **Meals** parsed from `## Питание` / `## Лог питания` / `## 🍽️ Съедено` table. Leading emoji becomes `meals.emoji`; the rest of the cell becomes `foodName` verbatim — the LLM's "Recent meals" block then references these names exactly. The `**ИТОГО**` row is skipped.
- **Day type** heuristic: presence of `Отдых` / `Rest day` → `rest`, else `training`.
- **Meal slots**: positional thirds — first third → Breakfast, middle → Lunch, last → Dinner. Timestamps anchored at 8:00 / 13:00 / 18:00 in the test user's local TZ (Pacific Time, configurable via `USER_TZ_OFFSET_HOURS` constant in the script).
- **Idempotent re-runs**: before inserting a day's meals, the script wipes every existing meal whose timestamp falls inside the user's local day for that date — including late-evening items that bleed into the next UTC day, and anything previously inserted manually via curl. Goals are upserted, not deleted, so dates not covered by any markdown stay intact.

## Auth (currently stub)

Every authenticated request must include an `X-User-Id` header (a UUID). The server upserts a user row keyed on this UUID. This is "dev grade" auth — it'll be replaced with Sign in with Apple or magic-link when the iOS client gets a login screen.

```bash
curl http://localhost:3000/meals \
  -H 'X-User-Id: 11111111-1111-1111-1111-111111111111'
```

## Layout

```
src/
├── index.ts              # Hono app + Bun.serve
├── env.ts                # Zod-validated env
├── db/
│   ├── client.ts         # postgres.js + Drizzle
│   └── schema.ts         # tables (Drizzle DSL)
├── routes/               # health, meals, goals, chat
├── middleware/           # auth, errors
└── llm/
    └── anthropic.ts      # Anthropic client

scripts/
└── import-md.ts          # markdown food-diary importer

tests/
├── setup.ts              # bun preload: per-process random schema + SDK mock
├── init.sql              # DDL mirroring schema.ts
├── helpers.ts            # makeApp, truncateAll, seed*, llmResponse
└── chat.test.ts          # representative integration tests
```

## Deploy (Fly.io + Neon)

The app runs on **Fly.io** (Bun-friendly, instant HTTPS, scale-to-zero), the database on **Neon free tier** (the connection string travels via Fly secrets — same `DATABASE_URL` env contract the local code uses).

Already in the repo:

- `Dockerfile` — two-stage Bun build (`oven/bun:1.3-alpine`, frozen prod install, no compile step).
- `.dockerignore` — excludes `tests/`, `scripts/`, `.env*`, `drizzle/`, etc.
- `fly.toml` — `iad` region (matches Neon), shared-cpu-1x / 256 MB VM, scale-to-zero, `/health` check, force HTTPS.

### One-time setup

Pick the path you prefer — the result is identical, both hand off to the same `flyctl deploy`.

**Web UI**:

1. [fly.io/dashboard](https://fly.io/dashboard) → **Launch new app** → name `food-tracker-api` (or any free name; update `app = …` in `fly.toml` to match), region `iad`, "Create app, deploy later".
2. App → **Secrets** → Add `ANTHROPIC_API_KEY` and `DATABASE_URL`.
3. Account → **Access tokens** → Create a deploy token (scope: deploy). Copy it once — needed for CI.

**CLI**:

```bash
brew install flyctl                      # or: curl -L https://fly.io/install.sh | sh
fly auth login

fly apps create food-tracker-api         # name is global; pick a free one
fly secrets set \
  ANTHROPIC_API_KEY='sk-ant-…' \
  DATABASE_URL='postgresql://neondb_owner:…@…neon.tech/neondb?sslmode=require'

fly tokens create deploy -x 999999h      # generate the deploy token for CI
```

Either way, `PORT`, `NODE_ENV`, `LOG_LEVEL` come from `fly.toml`'s `[env]` block — secrets are reserved for credentials.

### Deploy via GitHub Actions

`.github/workflows/deploy.yml` runs typecheck + `flyctl deploy --remote-only` (the build happens on Fly's builder, so the GH runner doesn't need Docker).

One-time wiring:

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name `FLY_API_TOKEN`, value = the deploy token from the setup step.

Triggers:

- Push to `main` touching backend code (`src/**`, `package.json`, `bun.lock`, `Dockerfile`, `fly.toml`, the workflow itself) — README/iOS-only changes don't trigger a redeploy.
- Manually via **Actions → Deploy → Run workflow** for the first deploy or out-of-band redeploys.

### Deploy from the laptop (fallback)

```bash
fly deploy                               # builds locally, pushes image
fly logs                                 # tail the running machine
curl https://food-tracker-api.fly.dev/health
# {"status":"ok"}
```

First request after idle wakes the machine (~1-2s) and Neon's branch (~300-500ms) — both sleep on inactivity. Combined wake-up is hidden inside any `/chat` round-trip to Anthropic.

### Updating the iOS client

After the URL is live, point the app at it and drop the localhost ATS exception:

1. `CalTracker/APIClient.swift` — change `baseURL` to `https://food-tracker-api.fly.dev`.
2. `CalTracker/Info.plist` — remove the entire `NSAppTransportSecurity` block (HTTPS is enough; no exception domain needed).

### Cost reality check

- Fly: free machine while idle, ~$1.94/mo if it stayed running 24/7. For an app that wakes a few times a day per request and sleeps in between, you'll be in the cents/month range.
- Neon: $0 on the free tier (0.5 GB storage, scale-to-zero, autosuspend after 5 min idle).
- Anthropic: pay-per-token — by far the dominant cost line for this app.
