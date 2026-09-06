# syntax=docker/dockerfile:1.7
#
# Build pipeline, all stages installing from the committed bun.lock so the image
# is built from the exact tree that was tested:
#
#   * `deps` installs production dependencies only — the seven packages src/
#     actually imports. Every frontend package is a devDependency, because the
#     built bundle is self-contained and the runtime never imports React.
#   * `webbuild` installs the full set and compiles the SPA to /app/web/dist.
#     Its own stage, so none of that tooling reaches the runtime image.
#   * The runtime image takes production node_modules plus the built bundle and
#     runs `bun src/index.ts` — Bun reads TS directly, no compile step.
#
# Both installs used to be `npm install --no-package-lock`, to sidestep Bun's
# parallel tarball downloader tripping ConnectionRefused on Depot builders. That
# traded one flake for two worse problems: npm re-resolved every ^range at build
# time, and on the current dependency graph it crashes outright — arborist dies
# with "Cannot read properties of null (reading 'edgesOut')". If the Bun
# installer ever flakes here, retry the deploy rather than going back to npm.

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS webbuild
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
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
