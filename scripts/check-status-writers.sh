#!/usr/bin/env bash
# Phase 4 of the state-management overhaul. CI-grade lint that prohibits
# direct mutation of `tab.status` / `inst.statusFields` outside the
# whitelisted dispatcher chokepoints.
#
# Why: the engine emits engine_status / engine_session_status as the
# authoritative state-of-session signal. Every direct write in client
# code is an opportunity to drift from the engine. Phase 4 funnels
# every writer through one chokepoint per client so a future bug like
# the Ion Operations stranding cannot be reintroduced silently.
#
# Whitelisted files (the dispatcher chokepoints):
#   - desktop/src/renderer/stores/slices/engine-event-status.ts
#     (the canonical engine_status handler for engine-view tabs)
#   - desktop/src/renderer/stores/slices/engine-event-slice.ts
#     (handles engine_message_end / engine_error / engine_dead → status
#      transitions for engine tabs)
#   - desktop/src/renderer/stores/slices/event-slice.ts
#     (handles task_complete / tab_status / engine_dead for CLI tabs)
#   - desktop/src/renderer/stores/slices/event-slice-extension-surface.ts
#     (extension-surface arms extracted from event-slice.ts to keep it under
#      the 600-line cap; uses instPatch staging, not direct statusFields
#      mutation — the commit happens in the parent event-slice.ts at line
#      `next.statusFields = instPatch.statusFields!`, which IS whitelisted)
#   - desktop/src/main/engine-control-plane.ts
#     (CLI-tab control plane; _setStatus is the chokepoint)
#   - desktop/src/main/engine-control-plane-events.ts
#     (CLI-tab event handler; uses ctx.setStatus)
#   - desktop/src/renderer/stores/slices/engine-slice.ts
#     (engineStart writes 'connecting' as a local UI synthetic until
#      the first engine_status arrives)
#   - desktop/src/renderer/stores/slices/engine-slice-submit.ts
#     (mirrors engine-slice for engine-view submits)
#   - desktop/src/renderer/stores/slices/permissions-slice.ts
#     (restoration injection)
#   - desktop/src/renderer/stores/slices/send-slice.ts
#     (CLI prompt submit writes 'connecting' as local synthetic)
#   - desktop/src/renderer/stores/slices/event-slice.ts already covered
#   - desktop/src/renderer/hooks/useHealthReconciliation.ts
#     (periodic reconcile against main-process state)
#   - desktop/src/renderer/hooks/useTabRestoration-engine.ts
#     (statusFields default at restore)
#   - desktop/src/main/prompt-pipeline-renderer.ts
#     (status promotion on CLI handoff)
#   - ios/IonRemote/ViewModels/SessionViewModel+SessionStatus.swift
#     (Phase 3 dispatcher)
#   - any *.test.ts / *Tests.swift file (tests are allowed to seed
#     state directly)
#
# Run via `make check-status-writers` or as part of `make test-all`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Whitelist: files that are permitted to mutate status / statusFields.
# Newline-separated; paths relative to repo root.
read -r -d '' WHITELIST <<'EOF' || true
desktop/src/renderer/stores/slices/engine-event-status.ts
desktop/src/renderer/stores/slices/engine-event-slice.ts
desktop/src/renderer/stores/slices/event-slice.ts
desktop/src/renderer/stores/slices/event-slice-extension-surface.ts
desktop/src/renderer/stores/slices/engine-slice.ts
desktop/src/renderer/stores/slices/engine-slice-submit.ts
desktop/src/renderer/stores/slices/permissions-slice.ts
desktop/src/renderer/stores/slices/send-slice.ts
desktop/src/renderer/stores/slices/engine-event-slice-messages.ts
desktop/src/renderer/hooks/useHealthReconciliation.ts
desktop/src/renderer/hooks/useTabRestoration-engine.ts
desktop/src/main/engine-control-plane.ts
desktop/src/main/engine-control-plane-events.ts
desktop/src/main/prompt-pipeline-renderer.ts
desktop/src/main/state.ts
ios/IonRemote/ViewModels/SessionViewModel+SessionStatus.swift
ios/IonRemote/ViewModels/SessionViewModel+EventHandlers.swift
ios/IonRemote/ViewModels/SessionViewModel+EngineEvents.swift
ios/IonRemote/ViewModels/SessionViewModel+TabEventHandlers.swift
ios/IonRemote/ViewModels/SessionViewModel+Commands.swift
ios/IonRemote/ViewModels/SessionViewModel+EngineCommands.swift
ios/IonRemote/ViewModels/SessionViewModel+ImplementPlan.swift
ios/IonRemote/ViewModels/SessionViewModel+Snapshot.swift
ios/IonRemote/ViewModels/SessionViewModel+Lifecycle.swift
EOF

# Patterns that flag a direct status mutation.
#   - `tab.status = …`
#   - `tabs[i].status = …`
#   - `t.status = …`
#   - `updated.status = …`
#   - `.statusFields = …`  (the legacy iOS-side write)
PATTERN='(\.status\s*=\s*[''"]|\.statusFields\s*=\s*[A-Za-z])'

# Files to scan: TS and Swift sources, excluding tests, build output,
# and the whitelist.
scan_paths=(
  "desktop/src"
  "ios/IonRemote"
)

violations=()
while IFS= read -r file; do
  # Skip test files — they may seed status for fixtures.
  case "$file" in
    *.test.ts|*Tests.swift|*Tests/*.swift|*__tests__*) continue ;;
  esac
  # Skip whitelist.
  if grep -Fxq "$file" <<<"$WHITELIST"; then
    continue
  fi
  # Skip the pure helper that is a specification, not a writer.
  case "$file" in
    desktop/src/main/remote/snapshot-derive.ts) continue ;;
    desktop/src/main/remote/snapshot.ts) continue ;;  # IIFE inline derivation, separately reviewed
  esac
  if grep -EHn "$PATTERN" "$file" >/dev/null 2>&1; then
    while IFS= read -r match; do
      violations+=("$match")
    done < <(grep -EHn "$PATTERN" "$file")
  fi
done < <(find "${scan_paths[@]}" \( -name '*.ts' -o -name '*.tsx' -o -name '*.swift' \) -type f 2>/dev/null)

if [ ${#violations[@]} -gt 0 ]; then
  echo "FAIL: status writers found outside whitelisted dispatcher files."
  echo ""
  echo "Every write to tab.status / inst.statusFields must go through"
  echo "the dispatcher chokepoint. If your change legitimately needs"
  echo "a new write site, add it to the WHITELIST in"
  echo "scripts/check-status-writers.sh and explain why in the PR."
  echo ""
  echo "Violations:"
  for v in "${violations[@]}"; do
    echo "  $v"
  done
  exit 1
fi

echo "status-writer check: OK (${#violations[@]} violations)"
