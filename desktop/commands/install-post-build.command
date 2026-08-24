#!/bin/bash
# Open a built Ion package only after the running desktop has fully exited.
#
# This is a developer convenience coordinator, not an installer. The .pkg is
# the only mechanism that writes /Applications/Ion.app in every human flow.
set -euo pipefail

PACKAGE_PATH="${1:?package path is required}"
LOG_FILE="${HOME}/.ion/dev-package-coordinator.log"

log() {
  mkdir -p "${HOME}/.ion"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"
}

[ -f "$PACKAGE_PATH" ] || { log "package missing: $PACKAGE_PATH"; exit 1; }

APP_PID=""
PID_FILE="$HOME/Library/Application Support/Ion/ion.pid"
if [ -f "$PID_FILE" ]; then APP_PID=$(cat "$PID_FILE" 2>/dev/null || true); fi
if [ -z "$APP_PID" ] || ! kill -0 "$APP_PID" 2>/dev/null; then
  APP_PID=$(pgrep -f 'Ion.app/Contents/MacOS/Ion$' 2>/dev/null | head -1 || true)
fi

if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
  log "requesting graceful Ion quit for developer package install, pid=$APP_PID"
  kill -USR1 "$APP_PID" 2>/dev/null || true

  # Ion's SIGUSR1 flow drains active work. This coordinator deliberately has
  # no timeout: it opens Installer only after the desktop has finished safely.
  while kill -0 "$APP_PID" 2>/dev/null; do
    sleep 1
  done
  log "Ion exited; opening package installer"
else
  log "Ion is not running; opening package installer"
fi

open "$PACKAGE_PATH"
log "package installer opened: $PACKAGE_PATH"
