# syntax=docker/dockerfile:1.7
#
# Two-stage Bun build for Fly.io.
#   * `deps` installs frozen prod dependencies once and is cacheable as long as
#     package.json + bun.lock are unchanged.
#   * Runtime image inherits node_modules and copies only what's needed to
#     `bun src/index.ts` — no build step (Bun reads TS natively).

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["bun", "src/index.ts"]
