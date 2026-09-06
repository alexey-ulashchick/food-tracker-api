#!/usr/bin/env bash
# Installs dependencies. Bun runs every script in this repo, but not the install:
# `bun install` cannot reach the registry from a GitHub runner at all. Every
# tarball fails with ConnectionRefused / FailedToOpenSocket, tiny ones included,
# and dropping --network-concurrency from 48 to 4 changed nothing. This is the
# same flake the Dockerfile has warned about since before the web client existed.
#
# So: npm, on the Node that setup-node pins in the workflow. Version matters —
# npm 10.8.2 (bundled with Node 20) cannot resolve this graph, dying in arborist
# with "Cannot read properties of null (reading 'edgesOut')". npm 10.9, bundled
# with Node 22, installs it cleanly. Do not lower node-version without checking
# that.
#
# `npm ci` is preferred once package-lock.json is committed: it installs the
# locked tree without resolving one, which sidesteps the arborist path above
# entirely. Until then `npm install` re-resolves every ^range on each run, so CI
# can pass on versions development never saw — worth fixing, but not worth
# blocking a deploy on.
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
