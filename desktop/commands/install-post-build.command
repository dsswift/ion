#!/bin/bash
# Install a source-built Ion.app once the running desktop has fully exited.
#
# Usage: install-post-build.command <staging-dir> [destination.app]
#
# <staging-dir> holds this build's Ion.app and belongs to this coordinator,
# which deletes it when the install ends. Ion is asked to drain (SIGUSR1) and
# waited on without a timeout, so active agent work always finishes. The
# in-app updater's install worker then swaps the bundle in as this user, with
# no Installer and no password.
set -euo pipefail

STAGING_DIR="${1:?staging directory is required}"
DEST_APP="${2:-/Applications/Ion.app}"
STAGED_APP="${STAGING_DIR}/Ion.app"
WORKER="$(cd "$(dirname "$0")/.." && pwd)/scripts/install-worker.sh"
LOG_FILE="${HOME}/.ion/dev-install-coordinator.log"

log() {
  mkdir -p "${HOME}/.ion"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"
}

trap 'rm -rf "$STAGING_DIR"' EXIT
[ -d "$STAGED_APP" ] || { log "staged app missing: $STAGED_APP"; exit 1; }

# pgrep -f takes an extended regular expression; the bundle path is a literal.
DEST_MAIN="$(printf '%s' "${DEST_APP}/Contents/MacOS/Ion" | sed -e 's/[][\.*^$+?(){}|]/\\&/g')"

APP_PID=""
PID_FILE="$HOME/Library/Application Support/Ion/ion.pid"
if [ -f "$PID_FILE" ]; then APP_PID=$(cat "$PID_FILE" 2>/dev/null || true); fi
if [ -z "$APP_PID" ] || ! kill -0 "$APP_PID" 2>/dev/null; then
  APP_PID=$(pgrep -f "^${DEST_MAIN}( |\$)" 2>/dev/null | head -1 || true)
fi

if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
  log "requesting graceful Ion quit for developer install, pid=$APP_PID"
  kill -USR1 "$APP_PID" 2>/dev/null || true

  # Ion's SIGUSR1 flow drains active work. This coordinator deliberately has
  # no timeout: it installs only after the desktop has finished safely.
  while kill -0 "$APP_PID" 2>/dev/null; do
    sleep 1
  done
  log "Ion exited; installing $DEST_APP"
else
  log "Ion is not running; installing $DEST_APP"
fi

# Ion has already exited, so the worker gets no pid to wait on, and this
# source build does not own the engine daemon, so it does not wait for that.
if bash "$WORKER" "$STAGED_APP" "$DEST_APP" 0 false; then
  log "install finished: $DEST_APP"
else
  status=$?
  log "install failed with exit $status; details in ${HOME}/.ion/install-worker.jsonl"
  exit "$status"
fi
