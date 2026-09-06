# syntax=docker/dockerfile:1.7
#
# Build pipeline:
#
#   * `deps` installs production dependencies only — the seven packages src/
#     actually imports. Every frontend package is a devDependency, because the
#     built bundle is self-contained and the runtime never imports React.
#   * `webbuild` installs the full set and compiles the SPA to /app/web/dist.
#     Its own stage, so none of that tooling reaches the runtime image.
#   * The runtime image takes production node_modules plus the built bundle and
#     runs `bun src/index.ts` — Bun reads TS directly, no compile step.
#
# On the Node version, which is load-bearing rather than incidental:
#
# node:20-slim bundles npm 10.8.2, and that npm cannot resolve this dependency
# graph at all — arborist dies with "Cannot read properties of null (reading
# 'edgesOut')". Both stages hit it, so an earlier guess that the
# --no-package-lock flag was to blame was simply wrong: webbuild never passed
# that flag and crashed identically. Node 22 ships npm 10.9, which installs the
# same package.json without complaint — that is what CI runs, and CI is green.
#
# `deps` looks like it should be immune, since --omit=dev leaves it seven
# packages. It is not: arborist builds the ideal tree from the whole manifest
# and only prunes dev dependencies when it writes node_modules, so this stage
# faces the full graph too. That is why it installed reliably for as long as the
# project had no frontend, and started failing the moment one arrived.
#
# `bun install` is not an option here. It cannot reach the registry from a CI
# network: every tarball fails with ConnectionRefused / FailedToOpenSocket, and
# throttling --network-concurrency from 48 to 4 changed nothing.
#
# Committing package-lock.json would make this sturdier still — `npm ci`
# installs a locked tree instead of resolving one, skipping the code path that
# crashed above entirely.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-slim AS webbuild
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
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
