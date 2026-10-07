#!/usr/bin/env bash
# Bundles scripts/perf/run.mts (the @ion/shared sources use extensionless
# imports Node's own resolver cannot follow) and runs it. Flags pass through.
#   scripts/perf/run.sh --scenario smoke [--out perf/results/smoke/<sha>.json] [--alloy http://localhost:4318]
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p build
npx --no -- esbuild scripts/perf/run.mts --bundle --platform=node --format=esm --target=node22 \
  --external:ws --tsconfig=server/tsconfig.json --outfile=build/perf-run.mjs --log-level=warning
ION_PERF_REPO_ROOT="$PWD" exec node build/perf-run.mjs "$@"
