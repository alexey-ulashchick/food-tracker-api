# syntax=docker/dockerfile:1.7
#
# Build pipeline:
#
#   * `deps` installs production dependencies only — the seven packages src/
#     actually imports. Every frontend package is a devDependency, because the
#     built bundle is self-contained and the runtime never imports React. This
#     stage keeps npm, which has installed this small, stable graph reliably for
#     as long as the project has deployed.
#   * `webbuild` installs the full set from the committed bun.lock and compiles
#     the SPA to /app/web/dist. Its own stage, so none of that tooling reaches
#     the runtime image.
#   * The runtime image takes production node_modules plus the built bundle and
#     runs `bun src/index.ts` — Bun reads TS directly, no compile step.
#
# The two installers fail in different ways, and the split above is chosen from
# what each one demonstrably survives:
#
#   * `npm install --no-package-lock` crashes arborist on the FULL graph
#     ("Cannot read properties of null (reading 'edgesOut')"), so webbuild cannot
#     use it. On the production-only graph it has always been fine.
#   * `bun install` at its default --network-concurrency of 48 saturates the
#     registry and dies with ConnectionRefused part-way through the
#     platform-specific tarballs. Four concurrent requests is steady, and the
#     retry covers a transient hiccup.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund

FROM oven/bun:1.3-slim AS webbuild
WORKDIR /app
COPY package.json bun.lock ./
# `ok` is checked explicitly: without it a loop that exhausts every attempt
# still exits 0, because `sleep` succeeded last.
RUN ok=; for attempt in 1 2 3; do \
      if bun install --frozen-lockfile --network-concurrency 4; then ok=1; break; fi; \
      echo "install attempt ${attempt}/3 failed, retrying"; sleep $((attempt * 5)); \
    done; \
    test -n "$ok"
COPY tsconfig.base.json vite.config.ts ./
COPY shared ./shared
COPY web ./web
RUN bunx vite build

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
