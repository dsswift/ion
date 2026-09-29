#!/usr/bin/env bash
# CI-grade lint that prohibits direct mutation of `tab.status` /
# `inst.statusFields` outside the whitelisted writer files.
#
# Why: the engine emits engine_status / engine_session_status as the
# authoritative state-of-session signal. Every direct write elsewhere is an
# opportunity to drift from the engine, so the set of files allowed to write
# is closed and listed here.
#
# The whitelist below carries one reason per file. Tests (*.test.ts,
# *Tests.swift, __tests__/) may seed state directly and are not scanned.
#
# Run via `make check-status-writers`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Whitelist: files that are permitted to mutate status / statusFields.
# One `path # reason` per line; paths relative to repo root.
read -r -d '' WHITELIST_WITH_REASONS <<'EOF' || true
server/src/store/slices/tab-status-transition.ts # setTabStatus, the seam for writes to the tabs array
server/src/store/slices/event-slice.ts # normalized-event reducer: session_init promotion, statusFields commit
server/src/store/slices/event-slice-task.ts # task and run-termination arms of the reducer
server/src/store/slices/event-slice-extension-surface.ts # extension-surface arms of the reducer
server/src/store/slices/engine-event-slice.ts # engine message-end / error / dead transitions
server/src/store/slices/engine-event-slice-messages.ts # message arms of the engine-event reducer
server/src/store/slices/engine-slice.ts # 'connecting' synthetic until the first engine_status
server/src/store/slices/engine-slice-submit.ts # 'connecting' synthetic on submit
server/src/store/slices/permissions-slice.ts # restoration injection
server/src/store/slices/send-slice.ts # 'connecting' synthetic on prompt submit
server/src/hooks/useTabRestoration-engine.ts # statusFields default at restore
server/src/engine/engine-control-plane.ts # session plane; _setStatus
server/src/engine/engine-control-plane-events.ts # session plane event handler; ctx.setStatus
server/src/engine/engine-control-plane-tab.ts # session plane tab reset
server/src/engine/studio-state-cache.ts # latest-status cache replayed to a late client
desktop/src/renderer/hooks/useHealthReconciliation.ts # periodic reconcile against the server
desktop/src/renderer/studio/visualizer/state/agent-cache.ts # visualizer's own agent cache
ios/IonRemote/ViewModels/SessionViewModel+SessionStatus.swift # status dispatcher
ios/IonRemote/ViewModels/SessionViewModel+EventHandlers.swift # engine status fields from the wire
EOF
WHITELIST="$(sed 's/ #.*$//' <<<"$WHITELIST_WITH_REASONS")"

# A whitelist entry that names a missing file is stale: the writer moved, and
# its new home is either unscanned or unlisted.
while IFS= read -r listed; do
  [ -z "$listed" ] && continue
  if [ ! -f "$listed" ]; then
    echo "FAIL: the whitelist names a file that does not exist: $listed"
    echo "Update the whitelist in scripts/check-status-writers.sh to the writer's current path."
    exit 1
  fi
done <<<"$WHITELIST"

# Patterns that flag a direct status mutation.
#   - `tab.status = …`
#   - `tabs[i].status = …`
#   - `t.status = …`
#   - `updated.status = …`
#   - `.statusFields = …`
PATTERN='(\.status\s*=\s*[''"]|\.statusFields\s*=\s*[A-Za-z])'

# Files to scan: TS and Swift sources, excluding tests and the whitelist.
scan_paths=(
  "server/src"
  "packages/shared/src"
  "desktop/src"
  "ios/IonRemote"
)

for scan_path in "${scan_paths[@]}"; do
  if [ ! -d "$scan_path" ]; then
    echo "FAIL: scan path does not exist: $scan_path"
    echo "Update scan_paths in scripts/check-status-writers.sh to where the code lives."
    exit 1
  fi
done

violations=()
while IFS= read -r file; do
  # Skip test files — they may seed status for fixtures.
  case "$file" in
    *.test.ts|*.test.tsx|*Tests.swift|*Tests/*.swift|*__tests__*) continue ;;
  esac
  # Skip whitelist.
  if grep -Fxq "$file" <<<"$WHITELIST"; then
    continue
  fi
  if grep -EHn "$PATTERN" "$file" >/dev/null 2>&1; then
    while IFS= read -r match; do
      violations+=("$match")
    done < <(grep -EHn "$PATTERN" "$file")
  fi
done < <(find "${scan_paths[@]}" \( -name '*.ts' -o -name '*.tsx' -o -name '*.swift' \) -type f 2>/dev/null)

if [ ${#violations[@]} -gt 0 ]; then
  echo "FAIL: status writers found outside whitelisted writer files."
  echo ""
  echo "Every write to tab.status / inst.statusFields must go through"
  echo "a whitelisted writer. If your change legitimately needs"
  echo "a new write site, add it to the whitelist in"
  echo "scripts/check-status-writers.sh with its reason."
  echo ""
  echo "Violations:"
  for v in "${violations[@]}"; do
    echo "  $v"
  done
  exit 1
fi

echo "status-writer check: OK (${#violations[@]} violations)"
