# Food Tracker API

Food Tracker: the API **and** the web client, in one repository.

Stores user data (meals, goals, weight, chat history) in Postgres and proxies LLM
calls to Anthropic Claude. The web app is served by the same Hono process on the
same origin, so there is no CORS layer and no second deploy.

The iOS app in `../ios-project` is being retired; every API change here has been
additive, so it keeps working until the cutover.

## Stack

- **Bun** runtime + TypeScript
- **Hono** web framework (serving via `Bun.serve`)
- **Drizzle ORM** + **postgres.js** driver
- **Postgres 16** — locally via `docker-compose`, or remote via [Neon](https://neon.tech) (free tier)
- **Anthropic Claude** via `@anthropic-ai/sdk`
- **Zod** for env + request validation
- **Biome** for lint + format
- **React 19 + Vite + Tailwind** for the web client (`web/`)
- **TanStack Query** for server state, **Zustand** for the little that is not
- **Vitest** for the client, **bun test** for the server, **Playwright** end to end

## Quick start

Requirements: Bun 1.1+, Docker (only if you want a local DB).

```bash
docker compose up -d                   # Postgres at localhost:5432
cp .env.example .env                   # add your ANTHROPIC_API_KEY
bun install
bun run db:push                        # apply schema (no migrations yet)
bun run dev                            # API at http://localhost:3000
```

For the web client, in a second terminal:

```bash
bun run web:dev                        # app at http://localhost:5173
```

Vite proxies every API path to `:3000`, so the browser only ever sees one origin
— the same arrangement as production. Log in with a token from
`bun run issue-token`.

To exercise what production actually serves, build the bundle instead and let
Hono serve it:

```bash
bun run web:build && bun run start     # everything on http://localhost:3000
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
| `bun run issue-token -- --user <uuid> [--label <name>]` / `:neon` | Issue an MCP bearer token for `/mcp/:token` (mobile Claude) |
| `bun run intervals:probe -- --key <k> --athlete <id> [--explain]` | Read-only census of the intervals.icu response, and how the app reads it |
| `bun test` | Backend tests (uses local docker by default) |
| `bun run web:dev` | Vite dev server for the web client, proxying the API |
| `bun run web:build` | Build the SPA into `web/dist`, which `src/static.ts` serves |
| `bun run test:web` | Vitest — client logic and components |
| `bun run test:e2e` | Playwright against the built app (needs `E2E_TOKEN`) |
| `bun run typecheck:web` / `:e2e` | `tsc` for the browser and Playwright projects |

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

## Auth (bearer token)

Every authenticated request — REST and MCP alike — must carry `Authorization: Bearer ft_<token>`. Tokens are stored in `api_tokens` (one user can hold many; revoke by setting `revoked_at`) and minted via:

```bash
bun run issue-token -- --user 11111111-1111-1111-1111-111111111111 --label 'iPhone'
bun run issue-token:neon -- --user 11111111-1111-1111-1111-111111111111 --label 'iPhone'
```

The script prints the plaintext token once — copy it immediately, there is no recovery.

```bash
# REST
curl http://localhost:3000/meals \
  -H 'Authorization: Bearer ft_...'

# MCP — same token, header form
curl -X POST http://localhost:3000/mcp \
  -H 'Authorization: Bearer ft_...' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# MCP — same token, URL-path form (for clients that can't set headers — e.g. mobile Claude)
curl -X POST http://localhost:3000/mcp/ft_... \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

This is "dev grade" auth — anyone holding the token can act as the user. Real per-device identity (magic link, passkeys) would replace this whole layer. The web client pastes the same token and keeps it in `localStorage`, which is a deliberate trade-off for a single-user app: any XSS leaks a credential that never expires and can only be revoked with SQL.

## MCP server (for Claude Desktop / Claude.ai / mobile)

The same backend exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint as a Streamable HTTP server. Tools wrap the existing routes so Claude can read and write meals, goals and
memories directly — twelve of them, matching the chat write tools name for name:

- meals: `list_meals`, `get_meals_for_day`, `add_meal`, `update_meal`, `delete_meal`
- goals: `list_goals`, `get_goal_for_day`, `set_goal`
- memories: `list_memories`, `add_memory`, `update_memory`, `delete_memory`

Two equivalent front-doors, same bearer token in both:

| URL | Auth | Use from |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer ft_<token>` header | Claude Desktop, curl |
| `POST /mcp/:token` | Token in URL path | Claude mobile (iOS/Android), Claude.ai web — anything that can't inject headers |

Both routes go through the same handler. The token-in-URL variant exists because the mobile Claude UI only takes a URL — there's no place to set headers. Anyone with the header (or the URL) acts as the user; treat both like passwords.

Mint a token with `bun run issue-token` (see [Auth](#auth-bearer-token)).

### Connect Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "food-tracker": {
      "type": "http",
      "url": "https://food-tracker-api-oc5olq.fly.dev/mcp",
      "headers": {
        "Authorization": "Bearer ft_..."
      }
    }
  }
}
```

For local development point `url` at `http://localhost:3000/mcp`. Restart Claude Desktop and the twelve tools show up in the connector list.

### Connect Claude mobile / Claude.ai web

The mobile UI doesn't let you set request headers, so use the URL-path variant.

Settings → Connectors → Add custom connector → URL:
```
https://food-tracker-api-oc5olq.fly.dev/mcp/ft_<token>
```

**Revoke** a token by setting `revoked_at` in the DB:

```sql
UPDATE api_tokens SET revoked_at = now() WHERE label = 'iPhone Claude';
```

### Smoke test from the terminal

```bash
# Header auth
curl -s -X POST http://localhost:3000/mcp \
  -H 'Authorization: Bearer ft_<token>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# URL-path auth (no header needed)
curl -s -X POST http://localhost:3000/mcp/ft_<token> \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Layout

```
shared/                   # wire types used by BOTH the server and the client
├── types.ts              # DTOs; src/db/wire-check.ts fails the build on drift
└── dietDayTitles.ts      # one verdict-name map, so chat and History agree

src/
├── index.ts              # Hono app + Bun.serve
├── env.ts                # Zod-validated env
├── static.ts             # serves web/dist; owns the /chat route split
├── db/
│   ├── client.ts         # postgres.js + Drizzle
│   ├── schema.ts         # tables (Drizzle DSL)
│   └── wire-check.ts     # type-level guard: schema vs shared/types.ts
├── routes/               # health, meals, goals, memories, weights, chat, day-summary
├── lib/                  # dietDayClassifier, recommend engine, mealLocalDate
├── middleware/           # auth, tokenAuth, errors
├── mcp/                  # MCP server (12 tools + Streamable HTTP route)
└── llm/
    ├── anthropic.ts      # Anthropic client (or the fake, under E2E_FAKE_LLM)
    ├── fakeAnthropic.ts  # scripted stand-in for end-to-end runs
    └── tools.ts          # tool schemas + executeTool

web/
├── index.html            # PWA meta, safe-area viewport
├── public/               # manifest.webmanifest, icons
└── src/
    ├── api/              # fetch wrapper, SSE parser, endpoints, query keys
    ├── components/       # rings (Canvas), charts (SVG), cards, chat bubbles
    │                     # AppLayout (shell), Sidebar (desktop), Page (screen root)
    ├── nav.ts            # the one place a section is declared; both navs read it
    ├── lib/              # pure logic: dates, metrics, weight, chat mapping
    ├── screens/          # Today, Chat, History, You, Memories, Weight, Login
    ├── theme/            # tokens ported from Theme.swift, hand-drawn icons
    └── store/            # UI-only Zustand state
e2e/                      # Playwright specs: app.spec.ts (phone), desktop.spec.ts

scripts/
├── import-md.ts          # markdown food-diary importer
└── issue-token.ts        # mints an ft_ bearer token

tests/
├── setup.ts              # bun preload: per-process random schema + SDK mock
├── init.sql              # DDL mirroring schema.ts
├── helpers.ts            # makeApp, truncateAll, seed*, llmResponse, readSse
└── *.test.ts             # chat, meals, weights, recommend, classifier, static
```

### The /chat collision

`/chat` is both a screen and an API endpoint. Renaming either was not an option:
the screen's URL should read `/chat`, and the iOS build in the field cannot be
changed. They are told apart by `Accept` — a browser navigation asks for
`text/html`, while `fetch` and `URLSession` do not. `tests/static.route.test.ts`
pins the behaviour, including a check that every client route really reaches the
app.

## Weight

There is no in-app entry UI. Weight arrives through `POST /weights`, which the
user's own sync script drives; the web client only reads it.

## Repeating a meal

Today's day header steps back a day at a time. On any day that is not today,
each logged meal grows a copy button that repeats it on today — for the case of
finding last Tuesday's breakfast and eating it again.

It takes two taps: the first arms the button, the second logs. Nothing in this
client can delete a meal — only the chat can — so an accidental log is annoying
to undo, and the second tap is also the only chance to confirm, since the total
that changed belongs to a day not on screen. A primed button disarms itself
after a few seconds rather than waiting to be fired by a stray tap.

The copy lands at the clock time the original row displays, not at the current
minute, so a breakfast copied in the evening still sits at breakfast time and
the day's log stays in the order it was eaten in.

## The PDF export

**История → PDF** downloads the whole observation period as A4, a few tens of
kilobytes: **page one is a dashboard, page two onward is the daily log** — one
line per day with the date, the goal, what was eaten, the difference and the
macros as they actually were.

The split is the answer to a first draft that put everything on one sheet. A
figure worth reading and a hundred and twenty-eight rows of evidence are two
different documents, and the reader who wants the second will turn the page.

Every day is exactly one of three, and its row is tinted accordingly rather than
marked with a symbol — green on target, red off target, grey **incomplete**. A
day is incomplete when it has no goal, or when under 60% of the goal was logged
against it: nobody eats 55% of their target and stops, they forget dinner.

Incomplete days are counted in the summary but kept out of the averages, and
their Diff column is left blank — the arithmetic is well defined and the figure
is exactly the deficit the report just declined to believe.

### The dashboard

Four blocks down the page, each behind a wide-tracked small-caps label and a
hairline rule, so it reads as a report rather than as a wall:

**Days** and **Intake** side by side, with the pie in a lane of its own to the
right — the four counts with their share of the period, against the averages
over complete days only. The lane is reserved rather than the circle nudged,
because "top right, level with the figures" put the pie exactly on top of the
Intake column: everything in it is right-aligned to the content edge, which is
where the pie was centred, so all four values were drawn underneath it.

**Outcome** puts two
numbers next to each other that are worth comparing and are nowhere else in the
app:

```
Cumulative deficit, 118 complete days   +6175 kcal
Predicted fat change                    -0.8 kg      ← deficit ÷ 7700
Measured weight change                  -2.3 kg      78.4 -> 76.1
```

7700 kcal per kilogram of fat is the usual figure. The two lines disagreeing is
the point of printing them together: a measured loss well past the predicted one
says the base expenditure in the tuning screen is set too low, or that some of
the drop is water and glycogen rather than fat. Neither reading is available from
either number alone.

Then two bar charts, a bar per ISO week:

```
deficit = Σ goal − Σ eaten,  over that week's complete days only
per day = deficit ÷ complete days
```

Incomplete days leave **both** sums before either is taken, so the two sides
always cover exactly the same days — dropping only the intake would inflate the
deficit by the whole missing goal. The sign is named rather than implied: planned
minus eaten, so a deficit is positive and points up.

Green when the week came out at or under plan, red when it came out over, **grey
when any day in it was incomplete**. Grey wins over red on purpose: the height is
a sum over the days that counted, so a week with a gap is drawn shorter than it
was. That is a fact about the bar rather than about the eating, and colouring it
by that height would assert something about a total known to be missing days.

The second chart is why the first is not enough. A six-day week and a seven-day
week are not comparable by total; per complete day they are, so a week that lost
a day to a gap can still be read against its neighbours.

Weeks are keyed by ISO week *and* year, or a report spanning New Year would merge
two different week 1s into one bar.

**The height is divided between the two directions by gridline count, not in
half.** Both sides share one scale — a +100 bar and a −100 bar have to come out
the same height or the chart lies — but a series that is almost entirely negative
was spending the whole upper half of the plot on blank paper, and the bars it did
have paid for that in height. Each direction now gets as many steps as its own
data needs, so a set of weeks that all overshot puts zero at the top and uses the
full drop.

**The axis follows the 85th percentile of the magnitudes, not the maximum.** One catastrophic week against nineteen ordinary ones sets a scale on
which the ordinary nineteen are slivers, which is the same as not drawing them.
Anything past the limit is drawn clipped — two pale notches across the tip, the
conventional break — with its real figure printed beyond it. Nothing is hidden;
the common range simply gets the height.

Last, **By month**: a row per calendar month with its day counts, its deficit and
its deficit per day. Twenty weekly bars answer a finer question than a
four-month report is usually asked, and five lines answer the coarse one.

The white space below it is deliberate. Filling it is what the first draft did.

### The daily log

Grouped under calendar-month headings, re-emitted at the top of each page so a
row is never orphaned from its month.

PDF has no arc operator, so the pie is cubic Béziers — control points at
4/3·tan(θ/4)·r along the tangents, split so no segment exceeds a quarter turn.
Sampled against a true circle it is within 0.012 pt at r = 50, and the test does
exactly that rather than trusting the formula.

History's weekly metrics apply the same rule from the same constant
(`INCOMPLETE_RATIO`), so the two surfaces cannot disagree about which days
count. That replaced the original
spec's rule, which treated a day with no meals as a perfect match "so blank days
do not drag compliance down" — exactly backwards: it scored silence as success,
so a week nobody logged read as flawless and forgetting to log pushed compliance
up.

Removing the fiction is not enough on its own. With blank days simply skipped, a
week with two logged days reports "2 / 2 · 100%", which is the same lie in the
same direction, so the rollup counts the days it refused and the metrics row
shows them: `2 / 2 в цели · 100% попаданий · 3 без данных`.

It is **in English**, and that is the whole design decision. The PDF format has
fourteen fonts every reader carries built in, and not one of them has a single
Cyrillic glyph — there is no encoding trick that adds them. Russian labels would
mean embedding a font, which together with a PDF library costs roughly half a
megabyte in a bundle that already warns about chunk size. So `web/src/lib/pdf.ts`
writes the file by hand: no dependency, no font, English labels, and every
string forced through `ascii()`.

That last part is not cosmetic. Byte offsets in the xref table are computed from
string length, which only equals the byte count while every character is one
UTF-8 byte, so one stray Cyrillic character would corrupt the file rather than
just look wrong. `buildPdf` refuses to emit a document containing one.

Since a PDF cannot be opened in CI, `pdf.test.ts` reads the xref table back the
way a reader would and asserts that every offset lands exactly on its object
header, that each stream declares its true length, and that the page tree counts
what it lists.

## Daily goals: computed, unless asked otherwise

A day's nutrition goal comes from one of two places, and `daily_goals.source`
records which.

**`auto`** is computed by `POST /training/sync` from the intervals.icu plan:

```
calories = base + weekday adjustment + 250 per strength session + Σ (planned kJ × coefficient)
protein  = the fixed figure from settings
fat      = the fixed figure from settings
carbs    = whatever calories are left over, floored at zero
```

Planned work is `joules` when the event carries it, and otherwise the sum of
watts × seconds over the plan's own steps — which reproduces intervals.icu's
figure to the joule where both exist.

The coefficient comes from the session's **defining block** — the hardest
intensity band holding at least ten minutes of planned work, or the band with
the most time if none reaches that:

| Class | Duration | × kJ |
|---|---|---|
| Z2 | ≤ 75 min | 0.70 |
| Z2 | 75 min – 2.5 h | 0.80 |
| Z2 | > 2.5 h | 0.90 |
| Sweet spot / threshold | any | 0.90 |
| VO₂max | any | 0.95 |
| no structured plan | any | 0.70, shown as «без плана» |
| watts with no FTP to scale them | any | 0.70, shown as «нет FTP» |

Every number in that table is editable at **Профиль → Расчёт цели**, together
with the band edges, the zone edges, the strength bonus, the defining-block
threshold, and a signed per-weekday adjustment — a flat nudge for how much
walking a given weekday usually involves, added to the base. Monday first; the
screen totals each day against the base as you type. The screen previews what the current values would do, live, before
saving — and it prices those examples at the athlete's own FTP, recorded by the
last sync (`user_settings.intervals_ftp`), because a ride's size is FTP × time ×
how hard it was ridden. Until a first sync records one, the preview says so and
falls back to 250 W rather than passing it off as yours.

The table above is the default. Only the fields that differ from it are stored
(`user_settings.goal_tuning`, overrides merged over `DEFAULT_TUNING` on read),
which is why a dial added later arrives at its default for everyone with no
backfill, and why `NULL` means "all defaults". Bounds live in
`shared/goalTuning.ts` and are enforced by both the form and `PATCH /settings`,
so the screen cannot offer a value the server rejects.

Saving changes the rules, not the goals already computed with the old ones —
«Пересчитать цели» on the same screen is what re-syncs. Past days are still
never recomputed.

Ten minutes rather than "the longest step" because a 3×12 sweet-spot workout
spends more time warming up and recovering than working, and longest-wins would
file it as Z2. The same threshold stops one 2-minute surge from promoting a
three-hour endurance ride to VO₂max. The arithmetic lives in
`src/lib/trainingLoad.ts`; the numbers it uses live in `shared/goalTuning.ts`,
which both the server and the settings screen read.

Steps are usually written in watts, so bands need an FTP to divide by. It is
taken, most specific first, from the plan's own `ftp`, then the athlete's
cycling FTP from intervals.icu, then recovered from the event itself — intensity
factor is NP / FTP and both are sent, so it falls out of the response. FTP is
deliberately not a stored setting: a figure typed into a form goes stale the
moment it changes in intervals.icu, while the watt targets in the plans move
with the real one.

**`manual`** is anything a human asked for — `set_goal` from chat, `PATCH
/goals`, the MCP tool. It always wins, and not by convention: the sync's upsert
carries `setWhere: source = 'auto'`, so a manual row refuses to be recomputed.
`clear_goal` or the delete button on **Профиль → Цели** removes the override and
hands the day back to the plan.

Two more rules worth knowing:

* **The past is frozen.** Days before today are inserted if missing but never
  updated, so editing an old workout in intervals.icu cannot retroactively move
  a target that has already been eaten against.
* **An unreadable plan is visible, not silent.** A ride the parser cannot
  classify scores at 0.70 and shows "тип не определён" on the goals screen; a
  ride with no planned kilojoules scores zero but still appears.

### Setting it up

`Профиль → Тренировки`: base expenditure, fixed protein and fat, athlete id and
API key (both under Settings → Developer at intervals.icu). The key goes in but
never comes back — `GET /settings` returns its last four characters and nothing
else.

That is the whole setup. Press **Обновить план** and the goals screen shows
each ride with its kilojoules, its class and the coefficient it scored at, so
the configuration checks itself against what intervals.icu shows you.

### When a number looks wrong

There are four ways the parser can misread a plan, and all four are visible on
the goals screen: `0 кДж` means no planned work was found and none could be
summed from the steps, `без плана` means the session has no structured steps at
all, `нет FTP` means it has steps in watts but nothing to scale them against,
and a gym session missing from the breakdown means its activity type is not in
`STRENGTH_TYPES`.

What the screen cannot say is *why*. For that:

```bash
bun run intervals:probe -- --key <api-key> --athlete i123456 --explain
```

Read-only. It prints which fields actually came back and which are null, the
distinct `type` and `category` values, the first structured `steps` array
verbatim, where FTP was resolved from for the first few events, and how each
session was classified — enough to tell "the plan has no kilojoules" from "the
field is called something else". The lists to edit are `JOULE_KEYS`,
`RIDE_TYPES` and `STRENGTH_TYPES` in `src/integrations/intervals.ts`.

This is not a hypothetical: the first version looked for FTP only in
`workout_doc.ftp`, which that account does not send, so every watt target was
unscalable and every ride came back unclassified while the kilojoules looked
perfectly fine. The probe found it in one run.

## Two shells, one breakpoint

The app is phone-first and stays a 480px column up to **1024px**, above which a
sidebar replaces the bottom tab bar and cards pair up into two columns. 1024 is
260 (sidebar) + 24 + a ~716 readable column + 24, and it keeps every iPad
portrait width on the phone layout.

Three rules make this work in a codebase written almost entirely in inline
`style={{}}`:

1. **Anything that ends up as a CSS value travels as a custom property.**
   `style={{ maxWidth: 'var(--action-card-max)' }}` keeps inline specificity but
   its value follows the media query, so no inline style had to be converted to
   a class. Mobile values are the base values — there is nothing for a phone to
   regress to.
2. **JS only for what ends up in arithmetic** — a canvas pixel size, an SVG
   `viewBox`, a component tree. `useIsDesktop()` reads `--desktop`, which CSS
   sets to 0 or 1, so the breakpoint literal exists once in the repository and
   cannot drift from a JS copy. Its only consumer is the shell choosing a nav.
3. **A layout class must not name a property that is also set inline on the same
   element**, or the class is dead at every width with nothing thrown.
   `web/src/theme/inlineOverride.test.ts` fails the build if that happens.

Type sizes are the exception to rule 1, because there are ~110 of them: every
inline size is written `calc(Npx * var(--type))`, so `--type` rescales the whole
app at once and keeps the design's internal ratios. It is 1 on a phone — the
port is pixel-faithful to the SwiftUI original — and 0.85 on a desktop, which
sits much further from the eye. That one number is what to turn if the text
feels wrong; `fontShorthand.test.ts` fails the build on a size that opts out.

## Two themes, from the OS

Colour follows `prefers-color-scheme`. There is no in-app switch.

Dark is the base and its values are byte for byte what shipped. Light is not
invented: each value is the light variant of the same iOS system colour dark
already uses — `systemGroupedBackground` for the page, white for a card,
`label`/`secondaryLabel` for text — and the Aurora macro gradients move two or
three steps down the Material ramps they came from, because a `#CCFF90` arc is
invisible on white.

Every colour is a `var(--c-…)` custom property, so `theme/tokens.ts` holds
variable references rather than literals and the ~500 inline `style={{ background:
surface.card }}` call sites needed no edit at all. Two consequences:

- **`withAlpha` uses `color-mix`.** It can no longer parse a hex, because by the
  time it runs the value is a `var()`.
- **Canvas cannot resolve a custom property.** The ring and the pie call
  `resolveColor()` to read the literal back out, and `useColorScheme()` is in
  their effect deps purely to force a redraw — canvas keeps its pixels while the
  tokens change underneath it. That hook has no other job; nothing else needs to
  know the theme.

`theme/colourLiterals.test.ts` fails the build on a colour spelled out in a
component, with a reasoned allowlist. That check exists because the failure is
silent: a hardcoded colour renders perfectly, it just never follows the theme.

One thing that does **not** follow the OS: `apple-mobile-web-app-status-bar-style`
takes no media attribute and iOS caches it at install time, so an installed
iPhone app in light mode keeps a black status bar. Changing that meta is what
produced the unpaintable bottom band documented in `web/index.html`, so it wants
its own pass on a device.

`e2e/desktop.spec.ts` is the only place the desktop layout is actually proven:
jsdom evaluates no media queries, and vitest blanks CSS imports, so no unit test
can assert one.

```bash
TOKEN=ft_...
curl -X POST localhost:3000/weights \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[{"date":"2026-03-01","kg":78.9},{"date":"2026-03-02","kg":78.4}]'
```

A single object works too. Rows upsert on `(user_id, date)`, so replaying a
backfill is safe — re-running the command above leaves two rows, not four.


## Deploy (Fly.io + Neon)

The app runs on **Fly.io** (Bun-friendly, instant HTTPS, scale-to-zero), the database on **Neon free tier** (the connection string travels via Fly secrets — same `DATABASE_URL` env contract the local code uses).

Already in the repo:

- `Dockerfile` — three stages: npm installs prod deps, a second stage builds the SPA, and `oven/bun:1.3-slim` runs `src/index.ts` with no compile step.
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
curl https://food-tracker-api-oc5olq.fly.dev/health
# {"status":"ok"}
```

First request after idle wakes the machine (~1-2s) and Neon's branch (~300-500ms) — both sleep on inactivity. Combined wake-up is hidden inside any `/chat` round-trip to Anthropic.

### Retiring the iOS client

The web app replaces `../ios-project`. Every API change made for it was
additive, so both clients can run side by side during the changeover:

1. Deploy, open the Fly URL on the phone and install it from the share sheet
   ("On Home Screen"). It launches without browser chrome.
2. Run both for a week. The one visible difference is that day verdicts are now
   Russian — `src/lib/dietDayClassifier.ts` is shared, so iOS shows them too.
3. Then archive the iOS repository. Do not delete it: it stays the reference for
   the visual details this port was measured against.

### Cost reality check

- Fly: free machine while idle, ~$1.94/mo if it stayed running 24/7. For an app that wakes a few times a day per request and sleeps in between, you'll be in the cents/month range.
- Neon: $0 on the free tier (0.5 GB storage, scale-to-zero, autosuspend after 5 min idle).
- Anthropic: pay-per-token — by far the dominant cost line for this app.
