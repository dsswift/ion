#!/usr/bin/env bash
# The Linux npm gates bind-mount the repo and run `npm ci`, which rewrites every
# workspace's node_modules. Each one must be an anonymous container volume, or
# the gate replaces the host's install with Linux binaries.
set -euo pipefail
cd "$(dirname "$0")/.."

dirs=(node_modules)
while IFS= read -r ws; do
  for d in $ws; do [ -f "$d/package.json" ] && dirs+=("$d/node_modules"); done
done < <(node -e 'for (const w of require("./package.json").workspaces) console.log(w)')

fail=0
for target in test-linux-desktop-run test-linux-server-run; do
  cmd="$(make -n "$target" | grep 'docker run')"
  for d in "${dirs[@]}"; do
    if ! grep -qF -- "-v /src/$d " <<<"$cmd "; then
      echo "  $target does not isolate /src/$d"
      fail=1
    fi
  done
done
[ "$fail" -eq 0 ] || { echo "❌ a Linux gate would overwrite a host node_modules"; exit 1; }
echo "linux gate mounts: ${#dirs[@]} node_modules isolated in both npm gates"
