#!/usr/bin/env bash
# Installs dependencies. Bun runs every script in this repo, but not the install
# — three approaches have been tried on GitHub runners and only the last works:
#
#   * `bun install` cannot reach the registry here at all. Every tarball fails
#     with ConnectionRefused / FailedToOpenSocket, tiny ones included, and
#     dropping --network-concurrency from 48 to 4 changed nothing. This is the
#     same flake the Dockerfile has warned about since before the web client
#     existed.
#   * `npm install --no-package-lock` crashes arborist on the full dependency
#     graph: "Cannot read properties of null (reading 'edgesOut')". The flag is
#     what does it — npm has to build an ideal tree with nothing to work from.
#   * `npm install`, allowed to use a lockfile, is fine. That runs below.
#
# `npm ci` is preferred once package-lock.json is committed, because it installs
# the locked tree without resolving anything. Until then `npm install` re-resolves
# every ^range on each run, so CI can pass on versions development never saw —
# worth fixing, but not worth blocking a deploy on.
set -euo pipefail

install_once() {
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
}

for attempt in 1 2 3; do
  if install_once; then
    exit 0
  fi
  echo "::warning::dependency install failed (attempt ${attempt}/3), retrying"
  sleep $((attempt * 5))
done

echo "::error::dependency install failed after 3 attempts"
exit 1
