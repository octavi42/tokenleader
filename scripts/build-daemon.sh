#!/usr/bin/env bash
#
# Compile the daemon with its build version baked in.
#
# Usage: build-daemon.sh <bun-target|''> <outfile>
#   build-daemon.sh ''                 bin/anara-leaderboard          # native
#   build-daemon.sh bun-darwin-arm64   bin/anara-leaderboard-arm64
#   build-daemon.sh bun-darwin-x64     bin/anara-leaderboard-x64
#
# Two values are injected via `bun build --define`. Bun 1.1.38 only honors
# the SPACE form (`--define K=V`); the esbuild colon form (`--define:K=V`)
# silently no-ops, so don't "simplify" this. Verified by running compiled
# arm64 + x64 binaries.
#
#   __TOKENLEADER_BUILD_SHA__      bare git short SHA, matching manifest.json
#                                  `buildSha`. Diagnostics only — logged,
#                                  never compared.
#   __TOKENLEADER_BUILD_VERSION__  semver tag when HEAD sits exactly on one;
#                                  else "v0.0.0-dev+<sha>". Override with
#                                  VERSION=... . The server compares this
#                                  string exactly to the manifest `version`,
#                                  so a divergence would false-flag the whole
#                                  fleet as stale.
#
# package.json's build:daemon* scripts call this, so CI and
# scripts/publish-release.sh both inject the values with no extra wiring.
set -euo pipefail

TARGET="${1:-}"
OUT="${2:?usage: build-daemon.sh <bun-target|''> <outfile>}"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"

VERSION="${VERSION:-}"
if [ -z "${VERSION}" ]; then
  VERSION="$(git describe --tags --exact-match 2>/dev/null || true)"
fi
if [ -z "${VERSION}" ]; then
  VERSION="v0.0.0-dev+${SHA}"
fi

ARGS=(build src/daemon/main.ts --compile \
  --define "__TOKENLEADER_BUILD_SHA__=\"${SHA}\"" \
  --define "__TOKENLEADER_BUILD_VERSION__=\"${VERSION}\"" \
  --outfile "${OUT}")
if [ -n "${TARGET}" ]; then
  ARGS+=(--target="${TARGET}")
fi

echo "build-daemon: ${OUT} (version=${VERSION}, sha=${SHA}${TARGET:+, target=${TARGET}})" >&2
exec bun "${ARGS[@]}"
