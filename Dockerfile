# syntax=docker/dockerfile:1.7
#
# Build pipeline:
#   * `deps` uses Node + npm to install production dependencies. We use npm
#     here instead of `bun install` because Bun's parallel tarball downloader
#     keeps tripping ConnectionRefused/FailedToOpenSocket on Depot and GitHub
#     Actions builders — npm is single-threaded enough to be reliable.
#     Local dev still uses `bun install` against bun.lock; this is CI-only.
#   * Runtime image inherits node_modules and runs `bun src/index.ts` —
#     Bun reads TS directly, no compile step.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["bun", "src/index.ts"]
