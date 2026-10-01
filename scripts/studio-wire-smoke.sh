#!/usr/bin/env bash
# Bundles scripts/studio-wire-smoke.mts (the @ion/shared sources use
# extensionless imports Node's own resolver cannot follow) and runs it.
#   scripts/studio-wire-smoke.sh --host oscar.local [--keep] [--link <ion-studio://…>]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
npx --no -- esbuild scripts/studio-wire-smoke.mts --bundle --platform=node --format=esm --target=node22 \
  --external:ws --external:bonjour-service --tsconfig=server/tsconfig.json --outfile=build/studio-wire-smoke.mjs --log-level=warning
exec node build/studio-wire-smoke.mjs "$@"
