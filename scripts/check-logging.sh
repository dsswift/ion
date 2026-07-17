#!/usr/bin/env bash
# ADR-019 logging-standards enforcement gate.
#
# Scans emitter call sites for violations of the operational-log standards
# defined in ADR-019 (docs/architecture/adr/019-logging-architecture-and-standards.md)
# and docs/observability/log-schema.md.
#
# Six check categories:
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
cnt_ts_interp=0
cnt_swift_interp=0
cnt_non_canon=0
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
    TS-INTERP)    cnt_ts_interp=$(( cnt_ts_interp + 1 )) ;;
    SWIFT-INTERP) cnt_swift_interp=$(( cnt_swift_interp + 1 )) ;;
    NON-CANON)    cnt_non_canon=$(( cnt_non_canon + 1 )) ;;
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

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 4: TypeScript interpolated msg
# ─────────────────────────────────────────────────────────────────────────────
#
# Flags main/renderer logger calls where the msg argument is a template literal
# containing ${...}. Covers log(), debug(), info(), warn(), error(), trace() in
# main/logger.ts and rTrace/rDebug/rInfo/rWarn/rError in rendererLogger.ts.

check_ts_interp() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  scan_grep "TS-INTERP" \
    '\b(log|debug|info|warn|error|trace|rTrace|rDebug|rInfo|rWarn|rError)\s*\([^`]*`[^`]*\$\{' \
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

check_non_canon() {
  local files=("$@")
  [[ ${#files[@]} -eq 0 ]] && return
  local key_pat='"(runID|sessionID|convID|durationMs|elapsedMs|elapsed_ms|errMsg|errorMsg|errStr)"'
  local file linenum rest
  while IFS=: read -r file linenum rest; do
    # Skip Go struct JSON tag lines — they are wire-protocol contract fields,
    # not logger field keys. Tag lines contain `json:" before the matched key.
    case "$rest" in
      *'`json:"'*) continue ;;
    esac
    report "NON-CANON" "$file" "$linenum" "$rest"
  done < <(grep -EHn "$key_pat" "${files[@]}" 2>/dev/null || true)
}

# ─────────────────────────────────────────────────────────────────────────────
# Dispatch
# ─────────────────────────────────────────────────────────────────────────────

# Engine Go
if [[ "$SCOPE" == "all" || "$SCOPE" == "engine" ]]; then
  ENGINE_GO=()
  while IFS= read -r f; do ENGINE_GO+=("$f"); done < <(find_go engine/)
  check_go_interp engine "${ENGINE_GO[@]}"
  check_non_canon "${ENGINE_GO[@]}"
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

  check_relay_go_interp "${RELAY_GO[@]}"
  check_relay_flat "${RELAY_NON_LOGGER[@]}"
  check_non_canon "${RELAY_GO[@]}"
fi

# Desktop renderer console.*
if [[ "$SCOPE" == "all" || "$SCOPE" == "renderer" ]]; then
  RENDERER_TS=()
  while IFS= read -r f; do RENDERER_TS+=("$f"); done < <(find_ts desktop/src/renderer/)
  check_renderer_console "${RENDERER_TS[@]}"
fi

# Desktop TS interpolated msg (main + renderer)
if [[ "$SCOPE" == "all" || "$SCOPE" == "ts" ]]; then
  DESKTOP_TS=()
  while IFS= read -r f; do DESKTOP_TS+=("$f"); done < <(find_ts desktop/src/)
  check_ts_interp "${DESKTOP_TS[@]}"
  check_non_canon "${DESKTOP_TS[@]}"
fi

# iOS Swift interpolation
if [[ "$SCOPE" == "all" || "$SCOPE" == "swift" ]]; then
  IOS_SWIFT=()
  while IFS= read -r f; do IOS_SWIFT+=("$f"); done < <(find_swift ios/)
  check_swift_interp "${IOS_SWIFT[@]}"
  check_non_canon "${IOS_SWIFT[@]}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "check-logging summary:"
printf "  %-12s (%s)\n" "GO-INTERP"    "interpolated msg in Go logger call:       $cnt_go_interp"
printf "  %-12s (%s)\n" "RELAY-FLAT"   "bare slog pkg call bypassing relayHandler: $cnt_relay_flat"
printf "  %-12s (%s)\n" "RENDERER"     "console.* in shipped renderer code:        $cnt_renderer"
printf "  %-12s (%s)\n" "TS-INTERP"    "template literal msg in TS logger call:    $cnt_ts_interp"
printf "  %-12s (%s)\n" "SWIFT-INTERP" "\\( interpolation in DiagnosticLog call:    $cnt_swift_interp"
printf "  %-12s (%s)\n" "NON-CANON"    "non-canonical field key in logger call:    $cnt_non_canon"
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
