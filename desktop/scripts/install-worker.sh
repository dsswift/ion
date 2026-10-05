#!/bin/bash
# install-worker — wait for Ion to exit, then atomically replace its bundle.
#
# Usage: install-worker.sh <source.app> <destination.app> <desktop-pid> [wait-for-engine].
# A desktop pid of 0 means the caller already waited for Ion to exit.
set -euo pipefail

SOURCE_APP="${1:?source Ion.app is required}"
DEST_APP="${2:?destination Ion.app is required}"
WAIT_PID="${3:?desktop pid is required}"
WAIT_FOR_ENGINE="${4:-false}"
LOG_DIR="${HOME}/.ion"
LOG_FILE="${LOG_DIR}/install-worker.jsonl"
MAX_WAIT_SECONDS=300
RELAUNCH_ATTEMPTS=3
# Overridable so a test need not wait out a launch that never comes.
RELAUNCH_WAIT_SECONDS="${ION_RELAUNCH_WAIT_SECONDS:-20}"
RELAUNCH_SETTLE_SECONDS="${ION_RELAUNCH_SETTLE_SECONDS:-3}"
# Each retry waits this much longer than the last, so a later attempt lands
# after whatever the quitting Ion left behind has finished shutting down.
RELAUNCH_BACKOFF_SECONDS="${ION_RELAUNCH_BACKOFF_SECONDS:-5}"
# Overridable so a test can stand in for macOS's app registry.
LSREGISTER="${ION_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"

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
# exact app bundle; never use a broad process-name match. pgrep -f takes an
# extended regular expression, and the bundle path is a literal.
DEST_PATTERN="$(printf '%s' "${DEST_APP}/Contents/" | sed -e 's/[][\.*^$+?(){}|]/\\&/g')"
STRAY_PIDS="$(pgrep -f "$DEST_PATTERN" 2>/dev/null || true)"
if [ -n "$STRAY_PIDS" ]; then
  # shellcheck disable=SC2086 # pgrep returns a whitespace-separated PID list.
  kill -9 $STRAY_PIDS 2>/dev/null || true
  log "helpers_reaped" ",\"count\":$(printf '%s\n' "$STRAY_PIDS" | wc -w | tr -d ' ')"
fi

PARENT_DIR="$(dirname "$DEST_APP")"
TEMP_DEST="${DEST_APP}.installing.$$"
rm -rf "$TEMP_DEST"

# Ion runs on this user's screen, so it starts only when this user is the one
# signed in there. An install over SSH to a Mac at its login window, or with
# someone else signed in, leaves Ion closed until this user signs in.
relaunch() {
  local console_user
  console_user="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
  if [ "$console_user" != "$(id -un)" ]; then
    log "relaunch_skipped" ",\"reason\":\"user not signed in on screen\",\"console_user\":\"$console_user\""
    return 0
  fi
  # `open` hands this script's environment to the app it starts. With
  # ELECTRON_RUN_AS_NODE set (a shell descended from Ion's local server has
  # it), Ion starts as a bare Node runtime and exits before it logs anything.
  if [ -n "${ELECTRON_RUN_AS_NODE+set}" ]; then
    log "relaunch_env_scrubbed" ",\"variable\":\"ELECTRON_RUN_AS_NODE\""
  fi
  local attempt=1
  while [ "$attempt" -le "$RELAUNCH_ATTEMPTS" ]; do
    if ! env -u ELECTRON_RUN_AS_NODE open "$DEST_APP"; then
      log "relaunch_attempt_failed" ",\"attempt\":$attempt,\"reason\":\"open failed\""
    elif launched; then
      log "relaunched" ",\"destination\":\"$DEST_APP\",\"attempt\":$attempt"
      return 0
    else
      log "relaunch_attempt_failed" ",\"attempt\":$attempt,\"reason\":\"not running\""
    fi
    if [ "$attempt" -lt "$RELAUNCH_ATTEMPTS" ]; then
      sleep $((attempt * RELAUNCH_BACKOFF_SECONDS))
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

# The main process of the installed bundle, if one is running. Helpers live
# under Contents/Frameworks, so the anchored path matches only the app itself.
running_pid() {
  pgrep -f "^${DEST_PATTERN}MacOS/Ion( |\$)" 2>/dev/null | head -n 1 || true
}

# `open` succeeding means only that Launch Services took the request; Ion can
# still fail to start. So an attempt counts only when the app's process
# appears and is still alive a moment later.
launched() {
  local waited=0 pid
  while [ "$waited" -lt "$RELAUNCH_WAIT_SECONDS" ]; do
    pid="$(running_pid)"
    if [ -n "$pid" ]; then
      sleep "$RELAUNCH_SETTLE_SECONDS"
      if kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
      log "relaunch_exited_early" ",\"pid\":$pid"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Ion is stopped from here on. A failure that leaves the installed bundle in
# place starts it again, so a failed update never leaves the app quit.
fail_and_relaunch() {
  rm -rf "$TEMP_DEST" 2>/dev/null || true
  if [ -d "$DEST_APP" ]; then
    relaunch || log "relaunch_after_failure_failed" ",\"destination\":\"$DEST_APP\""
  fi
  fail "$1"
}

# Copy beside the destination first. A failed copy leaves the known-good app
# untouched; only a complete staged bundle may replace it.
ditto "$SOURCE_APP" "$TEMP_DEST" || fail_and_relaunch "bundle_copy_failed"

# The installed bundle may belong to root (a package install put it there).
# This user cannot delete root's files, but an administrator can rename an
# entry of the folder it sits in. So the old bundle is set aside under the
# name the package scripts use and clean up, the new one takes its place, and
# the old one is deleted afterwards when it can be.
PREVIOUS_APP="${PARENT_DIR}/.$(basename "$DEST_APP").previous"
if [ -e "$DEST_APP" ]; then
  rm -rf "$PREVIOUS_APP" 2>/dev/null || true
  if [ -e "$PREVIOUS_APP" ]; then
    # An earlier set-aside bundle that cannot be deleted still holds the name.
    PREVIOUS_APP="${PREVIOUS_APP}.$$"
  fi
  mv "$DEST_APP" "$PREVIOUS_APP" || fail_and_relaunch "bundle_set_aside_failed"
  if ! mv "$TEMP_DEST" "$DEST_APP"; then
    mv "$PREVIOUS_APP" "$DEST_APP" || log "previous_bundle_restore_failed" ",\"previous\":\"$PREVIOUS_APP\""
    fail_and_relaunch "bundle_replace_failed"
  fi
  if rm -rf "$PREVIOUS_APP" 2>/dev/null; then
    log "previous_bundle_removed"
  else
    log "previous_bundle_left" ",\"previous\":\"$PREVIOUS_APP\",\"reason\":\"not deletable by this user\""
    # macOS keeps a renamed app on its list of known apps, so a launch by
    # bundle id or an ion:// link could still pick the set-aside copy.
    if [ ! -x "$LSREGISTER" ]; then
      log "previous_bundle_unregister_skipped" ",\"reason\":\"lsregister not found\""
    elif "$LSREGISTER" -u "$PREVIOUS_APP" 2>/dev/null; then
      log "previous_bundle_unregistered" ",\"previous\":\"$PREVIOUS_APP\""
    else
      log "previous_bundle_unregister_failed" ",\"previous\":\"$PREVIOUS_APP\""
    fi
  fi
else
  mv "$TEMP_DEST" "$DEST_APP" || fail "bundle_replace_failed"
fi

log "installed" ",\"destination\":\"$DEST_APP\""
relaunch || fail "relaunch_failed"
