#!/usr/bin/env bash
# Installs dependencies from the committed bun.lock.
#
# Two failure modes have been observed on GitHub runners, and this script exists
# to avoid both:
#
#   * `npm install --no-package-lock` crashes arborist on this dependency graph
#     ("Cannot read properties of null (reading 'edgesOut')"). It also re-resolved
#     every ^range on each run, so CI could pass on versions development never
#     saw.
#   * `bun install` at its default --network-concurrency of 48 saturates the
#     registry connection and dies with ConnectionRefused / FailedToOpenSocket
#     part-way through the platform-specific tarballs (esbuild, tailwind oxide,
#     lightningcss, rolldown). Four concurrent requests is steady, and slower
#     only by a couple of seconds because the tarballs are small.
#
# The retry covers whatever is left: a transient registry hiccup should not fail
# a build.
set -euo pipefail

for attempt in 1 2 3; do
  if bun install --frozen-lockfile --network-concurrency 4; then
    exit 0
  fi
  echo "::warning::dependency install failed (attempt ${attempt}/3), retrying"
  sleep $((attempt * 5))
done

echo "::error::dependency install failed after 3 attempts"
exit 1
