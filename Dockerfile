# syntax=docker/dockerfile:1.7
#
# Build pipeline:
#
#   * `deps` installs production dependencies only — the seven packages src/
#     actually imports. Every frontend package is a devDependency, because the
#     built bundle is self-contained and the runtime never imports React. This
#     stage keeps npm, which has installed this small, stable graph reliably for
#     as long as the project has deployed.
#   * `webbuild` installs the full set and compiles the SPA to /app/web/dist.
#     Its own stage, so none of that tooling reaches the runtime image.
#   * The runtime image takes production node_modules plus the built bundle and
#     runs `bun src/index.ts` — Bun reads TS directly, no compile step.
#
# The two installers fail in different ways, and the split above is chosen from
# what each one demonstrably survives:
#
#   * `npm install --no-package-lock` crashes arborist on the FULL graph
#     ("Cannot read properties of null (reading 'edgesOut')"), so webbuild cannot
#     use it. On the production-only graph it has always been fine.
#   * `bun install` cannot reach the registry from a CI network at all: every
#     tarball fails with ConnectionRefused / FailedToOpenSocket, and throttling
#     --network-concurrency from 48 to 4 made no difference. Hence npm for both
#     stages, with the crashing flag dropped from the one that needs dev
#     dependencies.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

FROM node:20-slim AS webbuild
WORKDIR /app
COPY package.json ./
# No --no-package-lock here: that flag is what crashes arborist on the full
# graph. Letting npm write its own lock keeps the tree build on the path that
# works.
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
