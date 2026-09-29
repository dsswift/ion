#!/usr/bin/env bash
# Pins scripts/check-lockfile-integrity.mjs: a complete lockfile passes, and an
# entry missing resolved or integrity fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/good.json" <<'JSON'
{"packages":{"":{"name":"x"},"desktop":{"version":"1.0.0"},"node_modules/ion":{"resolved":"desktop","link":true},
"node_modules/a":{"version":"1.0.0","resolved":"https://registry.npmjs.org/a/-/a-1.0.0.tgz","integrity":"sha512-x"}}}
JSON
cat >"$tmp/no-integrity.json" <<'JSON'
{"packages":{"node_modules/a":{"version":"1.0.0","resolved":"https://registry.npmjs.org/a/-/a-1.0.0.tgz"}}}
JSON
cat >"$tmp/no-resolved.json" <<'JSON'
{"packages":{"node_modules/a/node_modules/b":{"version":"2.0.0","integrity":"sha512-x"}}}
JSON

node "$here/check-lockfile-integrity.mjs" "$tmp/good.json" >/dev/null
for bad in no-integrity no-resolved; do
  if node "$here/check-lockfile-integrity.mjs" "$tmp/$bad.json" >/dev/null 2>&1; then
    echo "expected $bad.json to fail"; exit 1
  fi
done
echo "lockfile integrity check: 3 cases passed"
