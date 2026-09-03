# syntax=docker/dockerfile:1.7
#
# Build pipeline:
#   * `deps` uses Node + npm to install production dependencies. We use npm
#     here instead of `bun install` because Bun's parallel tarball downloader
#     keeps tripping ConnectionRefused/FailedToOpenSocket on Depot and GitHub
#     Actions builders — npm is single-threaded enough to be reliable.
#     Local dev still uses `bun install` against bun.lock; this is CI-only.
#   * `webbuild` installs the FULL dependency set (Vite and the React types
#     live in devDependencies) and compiles the SPA to /app/web/dist. Keeping
#     it in its own stage means none of that tooling reaches the runtime image.
#   * Runtime image inherits production node_modules plus the built bundle and
#     runs `bun src/index.ts` — Bun reads TS directly, no compile step.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

FROM node:20-slim AS webbuild
WORKDIR /app
COPY package.json ./
RUN npm install --no-package-lock --no-audit --no-fund
COPY tsconfig.base.json vite.config.ts ./
COPY shared ./shared
COPY web ./web
RUN npx vite build

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
# src/static.ts serves this directory, resolved relative to the CWD (/app).
COPY --from=webbuild /app/web/dist ./web/dist
COPY package.json tsconfig.json tsconfig.base.json ./
COPY shared ./shared
COPY src ./src

EXPOSE 8080
CMD ["bun", "src/index.ts"]
