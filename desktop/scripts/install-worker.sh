#!/bin/bash
# install-worker — wait for Ion to exit, then atomically replace its bundle.
#
# Usage: install-worker.sh <source.app> <destination.app> <desktop-pid> [wait-for-engine] [build-root].
set -euo pipefail

SOURCE_APP="${1:?source Ion.app is required}"
DEST_APP="${2:?destination Ion.app is required}"
WAIT_PID="${3:?desktop pid is required}"
WAIT_FOR_ENGINE="${4:-false}"
BUILD_ROOT="${5:-}"
LOG_DIR="${HOME}/.ion"
LOG_FILE="${LOG_DIR}/install-worker.jsonl"
MAX_WAIT_SECONDS=300

mkdir -p "$LOG_DIR"

log() {
  local event="$1"
  local fields="${2:-}"
  printf '{"ts":"%s","component":"install-worker","event":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$fields" >> "$LOG_FILE"
}

fail() {
  log "failed" ",\"reason\":\"$1\""
  exit 1
}

[ -d "$SOURCE_APP" ] || fail "staged_source_missing"
[ -n "$WAIT_PID" ] || fail "missing_pid"

log "waiting_for_desktop" ",\"pid\":$WAIT_PID"
waited=0
if [ "$WAIT_PID" != "0" ]; then
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    if [ "$waited" -ge "$MAX_WAIT_SECONDS" ]; then
      fail "desktop_exit_timeout"
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

# The auto-update restart explicitly shuts the daemon down. A source build with
# no desktop process does not own that daemon and must not wait for it forever.
if [ "$WAIT_FOR_ENGINE" = "true" ]; then
  while [ -S "${HOME}/.ion/engine.sock" ]; do
    if [ "$waited" -ge "$MAX_WAIT_SECONDS" ]; then
      fail "engine_exit_timeout"
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

log "desktop_and_engine_stopped" ",\"waited_seconds\":$waited"

# A helper can survive its main process briefly. Reap only helpers from this
# exact app bundle; never use a broad process-name match.
STRAY_PIDS="$(pgrep -f 'Ion.app/Contents' 2>/dev/null || true)"
if [ -n "$STRAY_PIDS" ]; then
  # shellcheck disable=SC2086 # pgrep returns a whitespace-separated PID list.
  kill -9 $STRAY_PIDS 2>/dev/null || true
  log "helpers_reaped" ",\"count\":$(printf '%s\n' "$STRAY_PIDS" | wc -w | tr -d ' ')"
fi

PARENT_DIR="$(dirname "$DEST_APP")"
TEMP_DEST="${DEST_APP}.installing.$$"
rm -rf "$TEMP_DEST"

# Copy beside the destination first. A failed copy leaves the known-good app
# untouched; only a complete staged bundle may replace it.
ditto "$SOURCE_APP" "$TEMP_DEST" || fail "bundle_copy_failed"
rm -rf "$DEST_APP"
mv "$TEMP_DEST" "$DEST_APP" || fail "bundle_replace_failed"

log "installed" ",\"destination\":\"$DEST_APP\""
if [ -n "$BUILD_ROOT" ] && [ "${KEEP_BUILD_ARTIFACTS:-0}" != "1" ]; then
  rm -rf "$BUILD_ROOT/dist" "$BUILD_ROOT/release"
  log "build_artifacts_removed" ",\"build_root\":\"$BUILD_ROOT\""
fi
open "$DEST_APP" || fail "relaunch_failed"
log "relaunched" ",\"destination\":\"$DEST_APP\""
