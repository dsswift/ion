#!/usr/bin/env bash
# ADR-019 logging-standards enforcement gate.
#
# Scans emitter call sites for violations of the operational-log standards
# defined in ADR-019 (docs/architecture/adr/019-logging-architecture-and-standards.md)
# and docs/observability/log-schema.md.
#
# Nine check categories:
#
#   GO-INTERP    — Go logger call whose msg argument is a fmt.Sprintf(...)
#                  or uses string concatenation with +. Covers utils.Log,
#                  utils.Info, utils.Debug, utils.Warn, utils.Error,
#                  utils.Trace, utils.LogWithFields, utils.TraceWithFields
#                  (engine) and logger.* / connLog.* slog calls (relay).
#
#   RELAY-FLAT   — Direct slog package-level call (slog.Info etc.) in relay
#                  source files other than logger.go. These bypass relayHandler
#                  entirely and emit flat top-level attrs, regressing the A4f
#                  nesting fix.
#
#   RENDERER     — Any console.* call in shipped desktop/src/renderer/ code
#                  (zero tolerance — rendererLogger.ts exists for this).
#                  Excludes *.test.ts / *.test.tsx / __tests__ paths.
#
#   TS-INTERP    — TypeScript/TSX logger call (main or renderer) whose msg
#                  argument is a template literal containing ${...}.
#
#   SWIFT-INTERP — DiagnosticLog.* call whose msg argument contains \(
#                  Swift string interpolation.
#
#   NON-CANON    — Non-canonical field keys in logger call sites. Seeds the
#                  known-drift set from ADR-019: runID, sessionID, convID,
#                  durationMs, elapsedMs, elapsed_ms (shadow of duration_ms),
#                  errMsg, errorMsg, errStr.
#
#   SILENT-CATCH — Swallowed promise rejection (`.catch(() => {})` and friends)
#                  in desktop TS, or empty `catch {}` in iOS Swift. The "no
#                  silent failures" rule: a caught error must be observable.
#                  Opt out with a trailing `// silent-ok: <reason>` comment.
#
#   RESERVED-KEY — A logger call site whose fields use a machine-identity key
#                  (host, machine_id, mdm_device_id, mdm_serial). Every logger
#                  stamps these on each line and pipelines label lines with the
#                  device by them, so a URL's host logged as `host` would
#                  relabel the line with a fake device. Name the value for what
#                  it is (url_host, git_host, bind_host). Opt out with a
#                  trailing `// log-key-ok: <reason>`.
#
#   OS-LOGGER    — iOS `Logger(subsystem:)` (Apple unified logging) outside
#                  DiagnosticLog.swift. os.Logger only reaches Console.app, never
#                  the operator's ~/.ion/ios-diagnostic-logs.jsonl. All iOS
#                  logging must use DiagnosticLog. Opt out (rare) with a trailing
#                  `// os-logger-ok: <reason>` comment.
#
# This gate runs in CI as the `check-logging` job in `.github/workflows/quality.yml`.
# Any new violation added to the tree will fail the PR. See
# docs/architecture/adr/019-logging-architecture-and-standards.md for the full
# standards and the violation categories this script checks.
#
# Usage:
#   bash scripts/check-logging.sh           # full tree
#   bash scripts/check-logging.sh engine    # engine Go only
#   bash scripts/check-logging.sh relay     # relay Go only
#   bash scripts/check-logging.sh renderer  # desktop renderer only
#   bash scripts/check-logging.sh ts        # desktop TS (main+renderer)
#   bash scripts/check-logging.sh swift     # iOS Swift only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Scope filter: optional first argument limits to one category.
SCOPE="${1:-all}"

# ── Counters (plain integers — bash 3.2 compatible) ───────────────────────────
cnt_go_interp=0
cnt_relay_flat=0
cnt_renderer=0
cnt_node_console=0
cnt_ts_interp=0
cnt_swift_interp=0
cnt_non_canon=0
cnt_silent_catch=0
cnt_os_logger=0
cnt_reserved_key=0
total_violations=0

# ── Helpers ───────────────────────────────────────────────────────────────────

report() {
  local category="$1"
  local file="$2"
  local linenum="$3"
  local detail="$4"
  printf 'FAIL [%-12s] %s:%s  %s\n' "$category" "$file" "$linenum" "$detail" >&2
  case "$category" in
    GO-INTERP)    cnt_go_interp=$(( cnt_go_interp + 1 )) ;;
    RELAY-FLAT)   cnt_relay_flat=$(( cnt_relay_flat + 1 )) ;;
    RENDERER)     cnt_renderer=$(( cnt_renderer + 1 )) ;;
    NODE-CONSOLE) cnt_node_console=$(( cnt_node_console + 1 )) ;;
    TS-INTERP)    cnt_ts_interp=$(( cnt_ts_interp + 1 )) ;;
    SWIFT-INTERP) cnt_swift_interp=$(( cnt_swift_interp + 1 )) ;;
    NON-CANON)    cnt_non_canon=$(( cnt_non_canon + 1 )) ;;
    SILENT-CATCH) cnt_silent_catch=$(( cnt_silent_catch + 1 )) ;;
    OS-LOGGER)    cnt_os_logger=$(( cnt_os_logger + 1 )) ;;
    RESERVED-KEY) cnt_reserved_key=$(( cnt_reserved_key + 1 )) ;;
  esac
  total_violations=$(( total_violations + 1 ))
}

# scan_grep CATEGORY PATTERN FILE...
# Runs grep -En and reports each match line.
scan_grep() {
  local category="$1"
  local pattern="$2"
  shift 2
  local file linenum rest
  while IFS=: read -r file linenum rest; do
    report "$category" "$file" "$linenum" "$rest"
  done < <(grep -EHn "$pattern" "$@" 2>/dev/null || true)
}

# find_go DIRS — prints non-test .go files under DIRS, excluding vendor/.git.
find_go() {
  find "$@" \
    -type d \( -name vendor -o -name .git \) -prune -false \
    -o -type f -name '*.go' ! -name '*_test.go' -print
}

# find_ts DIRS — prints non-test .ts/.tsx files.
find_ts() {
  find "$@" \
    -type d \( -name node_modules -o -name dist -o -name out -o -name .git \) -prune -false \
    -o -type f \( -name '*.ts' -o -name '*.tsx' \) \
       ! -name '*.test.ts' ! -name '*.test.tsx' \
       ! -path '*/__tests__/*' -print
}

# find_swift DIRS — prints non-test .swift files.
find_swift() {
  find "$@" \
    -type d \( -name DerivedData -o -name build -o -name .git \) -prune -false \
    -o -type f -name '*.swift' ! -name '*Tests.swift' ! -path '*/Tests/*' -print
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 1: Go interpolated messages (engine + relay)
# ─────────────────────────────────────────────────────────────────────────────
#
# Flags logger calls where the msg argument is an fmt.Sprintf(...) call or a
# string concatenation expression. The grep patterns are single-line and catch
# the overwhelming majority of violations; multi-line Sprintf calls are caught
# at their opening line.

check_go_interp() {
  local label="$1"; shift
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return

  # fmt.Sprintf passed as msg to the named logger functions.
  scan_grep "GO-INTERP" \
    'utils\.(Log|Debug|Info|Warn|Error|Trace|LogWithFields|TraceWithFields)\s*\([^)]*fmt\.Sprintf\s*\(' \
    "${files[@]}"

  # String concatenation in the msg position: "prefix" + var or var + "suffix".
  scan_grep "GO-INTERP" \
    'utils\.(Log|Debug|Info|Warn|Error|Trace|LogWithFields|TraceWithFields)\s*\([^,]+,\s*"[^"]*"\s*\+' \
    "${files[@]}"
  scan_grep "GO-INTERP" \
    'utils\.(Log|Debug|Info|Warn|Error|Trace|LogWithFields|TraceWithFields)\s*\([^,]+,\s*[A-Za-z_][A-Za-z0-9_.()]*\s*\+\s*"' \
    "${files[@]}"

  # A printf verb in a literal msg: these loggers never format, so the verb
  # is written as-is ("type=%t") and the value it meant is lost.
  scan_grep "GO-INTERP" \
    'utils\.(Log|Debug|Info|Warn|Error|Trace|LogWithFields|TraceWithFields)\s*\([^)]*"[^"]*%[-+# 0-9.]*[sdvtqxXfgewT][^"]*"' \
    "${files[@]}"
}

check_relay_go_interp() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return

  # Relay uses slog-style: logger.Info("msg", ...) / connLog.Error("msg", ...).
  scan_grep "GO-INTERP" \
    '(logger|connLog)\.(Info|Debug|Warn|Error|Trace)\s*\([^)]*fmt\.Sprintf\s*\(' \
    "${files[@]}"
  scan_grep "GO-INTERP" \
    '(logger|connLog)\.(Info|Debug|Warn|Error|Trace)\s*\(\s*"[^"]*"\s*\+' \
    "${files[@]}"
  scan_grep "GO-INTERP" \
    '(logger|connLog)\.(Info|Debug|Warn|Error|Trace)\s*\(\s*[A-Za-z_][A-Za-z0-9_.()]*\s*\+\s*"' \
    "${files[@]}"
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 2: Relay flat top-level slog attrs (guards the A4f nesting fix)
# ─────────────────────────────────────────────────────────────────────────────
#
# Direct slog.Info/Debug/Warn/Error calls in relay source (outside logger.go)
# bypass relayHandler and emit flat top-level attrs without the "fields" nesting.

check_relay_flat() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  scan_grep "RELAY-FLAT" '\bslog\.(Info|Debug|Warn|Error|Log)\s*\(' "${files[@]}"
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 3: console.* in shipped renderer code
# ─────────────────────────────────────────────────────────────────────────────

check_renderer_console() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  scan_grep "RENDERER" 'console\.(log|debug|info|warn|error|trace)\s*\(' "${files[@]}"
}

# Same rule, every other TypeScript surface that has a real logger: desktop
# main, the server, and packages/shared. console.* in any of them goes to a
# stream nobody collects -- in a packaged Electron app or a container, nowhere
# at all -- while the file the operator reads says nothing happened. The scan
# was renderer-only, which is how server/src kept `no-console: off`.
check_node_console() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  scan_grep "NODE-CONSOLE" 'console\.(log|debug|info|warn|error|trace)\s*\(' "${files[@]}"
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 4: TypeScript interpolated msg
# ─────────────────────────────────────────────────────────────────────────────
#
# Flags logger calls where the msg argument is a template literal containing
# ${...}. Covers log(), debug(), info(), warn(), error(), trace() and the
# rTrace/rDebug/rInfo/rWarn/rError renderer family -- each with an optional
# leading underscore, which is how both server/src and desktop/src/main alias
# the imported logger before wrapping it (`import { log as _log }`). A plain
# \b never fires before an underscore, so every one of those wrappers used to
# slip the scan.

check_ts_interp() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  scan_grep "TS-INTERP" \
    '(^|[^A-Za-z0-9])_?(log|debug|info|warn|error|trace|rTrace|rDebug|rInfo|rWarn|rError)\s*\([^`]*`[^`]*\$\{' \
    "${files[@]}"
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 5: Swift DiagnosticLog interpolation
# ─────────────────────────────────────────────────────────────────────────────
#
# Flags DiagnosticLog.* calls whose msg argument contains \( (Swift string
# interpolation). In the raw source file the interpolation looks like \(expr).
# grep -E treats \( as a literal backslash followed by open-paren; we match
# it inside the string argument following the opening quote.

check_swift_interp() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  # The pattern matches DiagnosticLog.log/trace/debug/info/warn/error followed
  # by a paren-delimited argument that contains a backslash (the escape that
  # precedes the interpolation parens in Swift source).
  scan_grep "SWIFT-INTERP" \
    'DiagnosticLog\.(log|logCommand|trace|debug|info|warn|error)\s*\([^)]*\\' \
    "${files[@]}"
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 6: Non-canonical field keys
# ─────────────────────────────────────────────────────────────────────────────
#
# Seeds the known-drift set from ADR-019 § 5 / log-schema.md:
#   runID      -> run_id
#   sessionID  -> session_id  (as a quoted logger field key)
#   convID     -> conversation_id
#   durationMs -> duration_ms
#   elapsedMs  -> duration_ms  (shadow)
#   elapsed_ms -> duration_ms  (shadow)
#   errMsg / errorMsg / errStr -> error

# shellcheck source=scripts/check-logging-non-canon.sh
source "$REPO_ROOT/scripts/check-logging-non-canon.sh"

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 6b: Machine-identity keys at logger call sites (RESERVED-KEY)
# ─────────────────────────────────────────────────────────────────────────────
#
# The scan walks each logger call's whole argument list, so it lives in
# check-logging-reserved-keys.py rather than a one-line grep.

check_reserved_key() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  local file linenum rest
  while IFS=: read -r file linenum rest; do
    report "RESERVED-KEY" "$file" "$linenum" "$rest"
  done < <(printf '%s\n' "${files[@]}" | python3 scripts/check-logging-reserved-keys.py)
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 7: Silent catch / swallowed rejection (cross-surface)
# ─────────────────────────────────────────────────────────────────────────────
#
# The "no silent failures" rule: a failure branch must be observable. This
# catches two greppable swallow patterns that the other gates and lint rules do
# NOT cover:
#
#   TS   — `.catch(() => {})`, `.catch(() => undefined)`, `.catch(() => null)`:
#          a promise rejection consumed and discarded. no-floating-promises only
#          flags an UNHANDLED promise; a promise whose rejection is handled by an
#          empty arrow is "handled" as far as that rule is concerned, yet the
#          error still vanishes. This closes that hole.
#   Swift — empty `catch {}` / `catch { }`: an error caught and dropped.
#          (SwiftLint also flags this; check-logging gives a single cross-surface
#          net that runs without the SwiftLint toolchain.)
#
# Opt out on a legitimately-benign line with a trailing `// silent-ok: <reason>`
# comment. Test files are excluded via the find_* filters.

check_silent_catch_ts() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  local file linenum rest
  while IFS=: read -r file linenum rest; do
    case "$rest" in
      *'silent-ok:'*) continue ;;
    esac
    report "SILENT-CATCH" "$file" "$linenum" "$rest"
  done < <(grep -EHn '\.catch\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)' "${files[@]}" 2>/dev/null || true)
}

check_silent_catch_swift() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  local file linenum rest
  while IFS=: read -r file linenum rest; do
    case "$rest" in
      *'silent-ok:'*) continue ;;
    esac
    report "SILENT-CATCH" "$file" "$linenum" "$rest"
  done < <(grep -EHn 'catch\s*\{\s*\}' "${files[@]}" 2>/dev/null || true)
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 8: iOS os.Logger outside DiagnosticLog
# ─────────────────────────────────────────────────────────────────────────────
#
# os.Logger (Apple unified logging) writes only to Console.app, which is
# invisible on a device with no attached Xcode session — so any operational log
# routed through it never reaches the operator's ~/.ion/ios-diagnostic-logs.jsonl.
# All iOS logging must go through DiagnosticLog. The sole legitimate os.Logger is
# the fallback sink INSIDE DiagnosticLog.swift itself.

check_os_logger_swift() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  local file linenum rest
  while IFS=: read -r file linenum rest; do
    case "$file" in
      */DiagnosticLog.swift) continue ;; # the one legitimate os.Logger sink
    esac
    case "$rest" in
      *'os-logger-ok:'*) continue ;;
    esac
    report "OS-LOGGER" "$file" "$linenum" "$rest"
  done < <(grep -EHn 'Logger\(subsystem:' "${files[@]}" 2>/dev/null || true)
}

# ─────────────────────────────────────────────────────────────────────────────
# Dispatch
# ─────────────────────────────────────────────────────────────────────────────

# Engine Go
if [[ "$SCOPE" == "all" || "$SCOPE" == "engine" ]]; then
  ENGINE_GO=()
  while IFS= read -r f; do ENGINE_GO+=("$f"); done < <(find_go engine/)
  check_go_interp engine ${ENGINE_GO[@]+"${ENGINE_GO[@]}"}
  check_non_canon ${ENGINE_GO[@]+"${ENGINE_GO[@]}"}
  check_reserved_key ${ENGINE_GO[@]+"${ENGINE_GO[@]}"}
fi

# Relay Go
if [[ "$SCOPE" == "all" || "$SCOPE" == "relay" ]]; then
  RELAY_GO=()
  while IFS= read -r f; do RELAY_GO+=("$f"); done < <(find_go relay/)

  RELAY_NON_LOGGER=()
  while IFS= read -r f; do RELAY_NON_LOGGER+=("$f"); done < <(
    find relay/ \
      -type d \( -name vendor -o -name .git \) -prune -false \
      -o -type f -name '*.go' ! -name '*_test.go' ! -name 'logger.go' -print
  )

  check_relay_go_interp ${RELAY_GO[@]+"${RELAY_GO[@]}"}
  check_relay_flat ${RELAY_NON_LOGGER[@]+"${RELAY_NON_LOGGER[@]}"}
  check_non_canon ${RELAY_GO[@]+"${RELAY_GO[@]}"}
fi

# Desktop renderer console.*
if [[ "$SCOPE" == "all" || "$SCOPE" == "renderer" ]]; then
  RENDERER_TS=()
  while IFS= read -r f; do RENDERER_TS+=("$f"); done < <(find_ts desktop/src/renderer/)
  check_renderer_console ${RENDERER_TS[@]+"${RENDERER_TS[@]}"}
fi

# Desktop TS interpolated msg (main + renderer). Also covers packages/shared
# and server, both split out of desktop/src/shared and desktop/src/main by the
# Ion Studio Server program's repo-restructure child: the same canonical-field
# and silent-catch discipline applies wherever main-process logic now lives.
if [[ "$SCOPE" == "all" || "$SCOPE" == "ts" ]]; then
  DESKTOP_TS=()
  while IFS= read -r f; do DESKTOP_TS+=("$f"); done < <(find_ts desktop/src/ packages/shared/src/ server/src/)
  check_ts_interp ${DESKTOP_TS[@]+"${DESKTOP_TS[@]}"}
  check_non_canon ${DESKTOP_TS[@]+"${DESKTOP_TS[@]}"}
  check_reserved_key ${DESKTOP_TS[@]+"${DESKTOP_TS[@]}"}
  check_silent_catch_ts ${DESKTOP_TS[@]+"${DESKTOP_TS[@]}"}

  # console.* outside the renderer. The CLI is excluded: `server/src/cli/`
  # talks to a person on a terminal, where stdout IS the interface.
  NODE_TS=()
  while IFS= read -r f; do
    case "$f" in
      server/src/cli/*) continue ;;
    esac
    NODE_TS+=("$f")
  done < <(find_ts desktop/src/main/ packages/shared/src/ server/src/)
  check_node_console ${NODE_TS[@]+"${NODE_TS[@]}"}
fi

# iOS Swift interpolation
if [[ "$SCOPE" == "all" || "$SCOPE" == "swift" ]]; then
  IOS_SWIFT=()
  while IFS= read -r f; do IOS_SWIFT+=("$f"); done < <(find_swift ios/)
  check_swift_interp ${IOS_SWIFT[@]+"${IOS_SWIFT[@]}"}
  check_non_canon ${IOS_SWIFT[@]+"${IOS_SWIFT[@]}"}
  check_silent_catch_swift ${IOS_SWIFT[@]+"${IOS_SWIFT[@]}"}
  check_os_logger_swift ${IOS_SWIFT[@]+"${IOS_SWIFT[@]}"}
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "check-logging summary:"
printf "  %-12s (%s)\n" "GO-INTERP"    "interpolated msg in Go logger call:       $cnt_go_interp"
printf "  %-12s (%s)\n" "RELAY-FLAT"   "bare slog pkg call bypassing relayHandler: $cnt_relay_flat"
printf "  %-12s (%s)\n" "RENDERER"     "console.* in shipped renderer code:        $cnt_renderer"
printf "  %-12s (%s)\n" "NODE-CONSOLE" "console.* in main/server/shared code:      $cnt_node_console"
printf "  %-12s (%s)\n" "TS-INTERP"    "template literal msg in TS logger call:    $cnt_ts_interp"
printf "  %-12s (%s)\n" "SWIFT-INTERP" "\\( interpolation in DiagnosticLog call:    $cnt_swift_interp"
printf "  %-12s (%s)\n" "NON-CANON"    "non-canonical field key in logger call:    $cnt_non_canon"
printf "  %-12s (%s)\n" "SILENT-CATCH" "swallowed .catch / empty Swift catch:      $cnt_silent_catch"
printf "  %-12s (%s)\n" "OS-LOGGER"    "iOS os.Logger outside DiagnosticLog:       $cnt_os_logger"
printf "  %-12s (%s)\n" "RESERVED-KEY" "machine-identity key in logger call:       $cnt_reserved_key"
echo "  ─────────────────────────────────────────────────────────────────────────"
echo "  TOTAL:     $total_violations"

if [[ "$total_violations" -gt 0 ]]; then
  echo ""
  echo "Violations found. See FAIL lines above for file:line detail." >&2
  echo "Standard: docs/architecture/adr/019-logging-architecture-and-standards.md" >&2
  echo "Schema:   docs/observability/log-schema.md" >&2
  echo ""
  exit 1
fi

echo ""
echo "check-logging: OK (no violations)"
exit 0
