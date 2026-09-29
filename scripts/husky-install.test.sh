#!/usr/bin/env bash
# Pins .husky/install.mjs: the root prepare script must succeed where husky is
# absent (CI, and npm ci run from one workspace), and still install hooks
# where it is present.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp .husky/install.mjs "$tmp/install.mjs"

(cd "$tmp" && CI=true node install.mjs) || { echo "❌ fails in CI"; exit 1; }
(cd "$tmp" && CI= node install.mjs) >/dev/null || { echo "❌ fails without husky installed"; exit 1; }
if [ -d node_modules/husky ]; then
  CI= node .husky/install.mjs >/dev/null || { echo "❌ fails with husky installed"; exit 1; }
fi
echo "husky install: passes in CI, without husky, and with it"
