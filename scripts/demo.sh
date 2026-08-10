#!/usr/bin/env bash
# Curb demo: all three protections in ~60 seconds. No API key, no Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "→ pnpm install"
  pnpm install
fi

# why: workspace packages export ./dist, so the demo needs them built (and fresh).
echo "→ building workspace packages"
pnpm -r build >/dev/null

exec pnpm exec tsx scripts/demo.ts
