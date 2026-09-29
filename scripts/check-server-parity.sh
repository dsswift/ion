#!/usr/bin/env bash
# check-server-parity — spec 17's replacement for check-studio-parity.sh.
#
# Spec 17 deleted the Overlay presentation: Studio is now the only Electron
# window, and the server package (child 06) owns the session store outright.
# The old gate's purpose ("route pushes through broadcast() so the Studio
# mirror sees them too") is moot with one window left. The purpose this gate
# serves instead: "server owns the store, Studio renders" — a direct
# `webContents.send` from Electron main is now suspect in general, because
# conversation/session state should reach Studio over the studio-wire (the
# server's own event stream), not via ad-hoc main-process IPC pushes. A
# shrinking allowlist, not a vanishing one: window lifecycle/chrome plumbing
# and main-process-only tool results (Playwright, the graph engine, git
# watching) have no server-side home and legitimately still push directly.
set -euo pipefail
cd "$(dirname "$0")/.."

# ── Check 1: webContents.send stays inside main-process-only plumbing ──────
#
# Each entry below still has a genuine reason main must push directly rather
# than route the data through the server's studio-wire:
#   broadcast.ts             — the fan-out router itself; the one legitimate
#                              multi-window send helper other files call
#                              through instead of calling webContents directly.
#   studio-window-manager.ts — Studio window lifecycle/chrome (open state,
#                              permission-resolved ack, fullscreen chrome).
#   ipc/studio-browser.ts    — Playwright browser tool results: the browser
#                              runtime lives in main; Surface state lives in
#                              the Studio renderer, so results and view-state
#                              land directly in the Studio window.
#   ipc/studio-bridge.ts     — the studio-wire transport bridge itself: this
#                              IS the mechanism client state should route
#                              through, so its own frame delivery is exempt.
ALLOWLIST='broadcast\.ts|studio-window-manager\.ts|ipc/studio-browser\.ts|ipc/studio-bridge\.ts'

violations=$(grep -rn "webContents\.send(" desktop/src/main --include='*.ts' \
  | grep -v '__tests__' \
  | grep -vE "desktop/src/main/($ALLOWLIST)" || true)

if [ -n "$violations" ]; then
  echo "check-server-parity: direct webContents.send outside the main-process-only allowlist."
  echo "Route conversation/session state through the server's studio-wire instead,"
  echo "or add the file to ALLOWLIST in scripts/check-server-parity.sh with a reason."
  echo
  echo "$violations"
  exit 1
fi

# ── Check 2: no executeJavaScript round-trips remain ────────────────────────
#
# The server package replaced every renderer-store `executeJavaScript` poll
# with a direct store call (child 06). A real call (not a comment mentioning
# the historical mechanism) anywhere in main or the server package is a
# regression back to the deleted polling design.
ejs_calls=$(grep -rn "\.executeJavaScript(" desktop/src/main server/src --include='*.ts' \
  | grep -v '__tests__' \
  | grep -vE '^\s*[a-zA-Z0-9_/.:-]+:[0-9]+:\s*(//|\*|/\*)' || true)

if [ -n "$ejs_calls" ]; then
  echo "check-server-parity: found a live executeJavaScript() call outside tests."
  echo "The server package owns the store directly now; call it in-process instead."
  echo
  echo "$ejs_calls"
  exit 1
fi

# ── Check 3: single-UI exclusivity keys deleted, not resurrected ───────────
#
# activeUi/activeUiPolicy/surfacePolicy/launchSurface encoded a choice between
# Studio and the (deleted) Overlay. Only settings-migration-studio.ts (the
# migration that deletes them), settings-split.ts (an unrelated, older
# legacy-key-stripping mechanism from spec 12 that predates and also lists
# these same four names), and each file's own test may still name them.
LEGACY_KEY_ALLOWLIST='desktop/src/main/settings-migration-studio\.ts|desktop/src/main/__tests__/settings-migration-studio\.test\.ts|desktop/src/main/settings-split\.ts|desktop/src/main/__tests__/settings-split\.test\.ts|desktop/src/main/ipc/__tests__/studio\.test\.ts'

legacy_key_hits=$(grep -rln "activeUi\|launchSurface\|surfacePolicy" desktop/src packages/shared/src 2>/dev/null \
  | grep -vE "^($LEGACY_KEY_ALLOWLIST)\$" || true)

if [ -n "$legacy_key_hits" ]; then
  echo "check-server-parity: single-UI exclusivity keys (activeUi/activeUiPolicy/"
  echo "surfacePolicy/launchSurface) found outside the migration + legacy-strip files."
  echo "These keys were deleted with the Overlay (spec 17) — remove the reference,"
  echo "or add the file to LEGACY_KEY_ALLOWLIST with a reason."
  echo
  echo "$legacy_key_hits"
  exit 1
fi

# ── Check 4: no import of a path spec 17 deleted ────────────────────────────
DELETED_PATHS='main/active-ui|main/surface-launch|main/ipc/window\b|components/settings/InterfacePicker|components/InboxPanel\b|components/questions/QuestionsOverlayHost|hooks/useClickThrough|shared/enterprise-active-ui-policy'

deleted_import_hits=$(grep -rnE "$DELETED_PATHS" desktop/src --include='*.ts' --include='*.tsx' \
  | grep -v '__tests__' || true)

if [ -n "$deleted_import_hits" ]; then
  echo "check-server-parity: reference to a path spec 17 deleted."
  echo
  echo "$deleted_import_hits"
  exit 1
fi

# ── Check 5: what Electron main may import from @ion/server ────────────────
#
# Spec 12 / ADR-033: the Electron main process is a shell plus a transport
# broker. The Studio server child owns the store, the engine bridge, the
# device transport and every per-Environment orchestration. Main reaching
# into `@ion/server/*` for anything beyond shared plumbing is how a second
# copy of the server's business logic ends up running inside Electron --
# two processes adopting every tab, two engine sockets, schedules firing
# twice. That drift is invisible to every other gate, so this one names the
# permitted set explicitly.
#
# This list only SHRINKS. It is seeded with today's imports so the gate
# lands green; each commit of the shell-extraction plan removes the entries
# whose owner moved. The final set is:
#   paths, logger, ipc-validation, machine-identity, utils/secretStore
#   (one-time Keychain migration), utils/temp-dir, persistence/settings-store
#   (settings-split only), persistence/studio-settings-keys, deeplink/*,
#   engine/engine-supervisor*, engine/engine-bootstrap, engine/engine-address
#   (the LOCAL engine daemon), studio-playwright/tool-contracts, and shared
#   types. Anything else main needs from the server it asks for over the wire.
SERVER_IMPORT_ALLOWLIST="$(cat <<'LIST'
deeplink/confirm
deeplink/dispatch
deeplink/handoff
deeplink/token
engine/engine-address
engine/engine-bootstrap
engine/engine-export-handler
engine/engine-supervisor
git/focus-state
git/git-runner
integration/bench-store
ipc-validation
launch-env
machine-identity
oauth/entra-config
paths
persistence/settings-store
studio-playwright/tool-contracts
telemetry-frame
utils/atomicWrite
utils/secretStore
utils/temp-dir
watchdog
worktree/registry
LIST
)"

server_imports=$(grep -rhoE "from ['\"]@ion/server/[^'\"]+" desktop/src/main --include='*.ts' \
  --exclude-dir=__tests__ \
  | sed -E "s/from ['\"]@ion\/server\///" | sort -u || true)

unlisted_imports=$(comm -23 <(printf '%s\n' "$server_imports") <(printf '%s\n' "$SERVER_IMPORT_ALLOWLIST" | sort -u) || true)

if [ -n "$unlisted_imports" ]; then
  echo "check-server-parity: desktop/src/main imports an @ion/server module outside SERVER_IMPORT_ALLOWLIST."
  echo "Main is a shell plus a transport broker (spec 12, ADR-033): reach the server over"
  echo "the studio-wire (broker.sendAction / a studio_action) instead of importing its code."
  echo "The allowlist only shrinks; do not add to it."
  echo
  echo "$unlisted_imports"
  exit 1
fi

# ── Check 6: the renderer reaches window.ion only through the host seam ────
#
# Spec 12 L88: `window.ion` is the Electron preload; the renderer's one
# route to the shell is `StudioHost` (`desktop/src/renderer/host/`), which
# a browser client implements without a preload at all. A direct
# `window.ion.verb()` in a component is a surface that silently does not
# exist in a browser tab. Comments and `typeof`/optional-chain probes in
# the host and preload directories are the seam itself and are exempt, as
# are tests and the splash window (its own `window.ionStartup` preload).
#
# This list only SHRINKS; it reached its final, empty set. Nothing is added.
WINDOW_ION_ALLOWLIST="$(cat <<'LIST'
LIST
)"

window_ion_files=$(grep -rnE "window\.ion\b" desktop/src/renderer --include='*.ts' --include='*.tsx' \
  --exclude-dir=__tests__ --exclude-dir=host --exclude-dir=splash \
  | grep -vE '\.test\.tsx?:' \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' \
  | cut -d: -f1 | sort -u || true)

unlisted_window_ion=$(comm -23 <(printf '%s\n' "$window_ion_files") <(printf '%s\n' "$WINDOW_ION_ALLOWLIST" | sort -u) || true)

if [ -n "$unlisted_window_ion" ]; then
  echo "check-server-parity: renderer file reaches window.ion outside WINDOW_ION_ALLOWLIST."
  echo "Go through the StudioHost seam (host.shell.<verb>, gated on a capability the"
  echo "browser genuinely lacks) so the same surface exists in a browser Studio client."
  echo "The allowlist only shrinks; do not add to it."
  echo
  echo "$unlisted_window_ion"
  exit 1
fi

# ── Check 7: the desktop main process never touches the engine or the store ──
#
# ADR-033: the Studio server is the engine's one client and the session
# store's one owner. The desktop main process is a Studio client that
# spawns that server and reaches it over the Studio wire; an import of the
# engine bridge, the session plane, the session store, the event wiring or
# the server's process state from `desktop/src/main` would give this process
# a second, disconnected copy of what the server owns -- an engine bridge
# that never connects, a store nothing feeds -- and every call into it would
# look successful while doing nothing. Tests are exempt: they mock these
# modules to test server code from the desktop suite.
forbidden_main_imports=$(grep -rnE "from ['\"]@ion/server/(state|engine/engine-bridge[^'\"]*|engine/engine-control-plane[^'\"]*|engine/event-wiring[^'\"]*|store/[^'\"]*|automation/runtime)['\"]|\b(sessionPlane|engineBridge|useSessionStore|wireSessionPlaneEvents|wireEngineBridgeEvents|wireRemoteSessionPlaneForwarding|wireAutomationRuntime)\b" \
  desktop/src/main --include='*.ts' --exclude-dir=__tests__ \
  | grep -vE '\.test\.tsx?:' \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' || true)

if [ -n "$forbidden_main_imports" ]; then
  echo "check-server-parity: desktop/src/main reaches the engine or the session store directly."
  echo "The Studio server owns the engine bridge, the session plane and the store (ADR-033);"
  echo "the desktop main process reaches them only over the Studio wire (broker.sendAction)."
  echo
  echo "$forbidden_main_imports"
  exit 1
fi

echo "check-server-parity: OK"
