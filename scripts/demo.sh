#!/usr/bin/env bash
# Demo Curb: tiga perlindungan dalam ~60 detik, tanpa API key & tanpa docker.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "→ pnpm install"
  pnpm install
fi

exec pnpm exec tsx scripts/demo.ts
