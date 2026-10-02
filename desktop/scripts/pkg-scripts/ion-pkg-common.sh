#!/bin/bash
# ion-pkg-common.sh — shared by preinstall and postinstall (sourced, never run).
#
# The package payload lands in STAGING_DIR, never in /Applications. postinstall
# swaps the complete staged bundle into place with two renames, so the
# installed bundle is always either the whole previous version or the whole
# new one.
#
# What happens to a running Ion is device policy, read from the Managed
# Preferences payload at customFields['ion-desktop'].installer:
#
#   runningApp           "refuse" (default) leaves a running Ion alone and
#                        fails the install; "replace" stops it and proceeds.
#   drainTimeoutSeconds  how long "replace" waits for the graceful drain
#                        before forcing the quit.
#
# The ION_PKG_* variables exist so a test can point the scripts at a sandbox.
# shellcheck disable=SC2034 # the sourcing scripts read these paths.

APP_NAME="Ion"
APP_PATH="${ION_PKG_APP_PATH:-/Applications/${APP_NAME}.app}"
STAGING_DIR="${ION_PKG_STAGING_DIR:-/Library/Application Support/Ion/pkg-staging}"
STAGED_APP="${STAGING_DIR}/${APP_NAME}.app"
APP_PARENT="$(dirname "$APP_PATH")"
PREVIOUS_APP="${APP_PARENT}/.${APP_NAME}.app.previous"
INCOMING_APP="${APP_PARENT}/.${APP_NAME}.app.incoming"
POLICY_PLIST="${ION_PKG_POLICY_PLIST:-/Library/Managed Preferences/com.ion.engine.plist}"
POLICY_KEY=":customFields:ion-desktop:installer"
LOG_FILE="${ION_PKG_LOG_FILE:-/var/log/install.log}"

DEFAULT_DRAIN_TIMEOUT_SECONDS=300
# Both package scripts share one system timeout each. The drain bound is capped
# so drain + forced quit + kill always ends before that timeout does.
MAX_DRAIN_TIMEOUT_SECONDS=480
FORCED_QUIT_WAIT_SECONDS="${ION_PKG_FORCED_QUIT_WAIT_SECONDS:-30}"
KILL_WAIT_SECONDS="${ION_PKG_KILL_WAIT_SECONDS:-5}"

log() { printf '[Ion %s] %s\n' "$SCRIPT_NAME" "$1" | tee -a "$LOG_FILE"; }

# pgrep -f takes an extended regular expression; the bundle path is a literal.
regex_escape() { printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|]/\\&/g'; }

# The main executable of the bundle being replaced, with or without arguments.
# Helpers live deeper in the bundle and never match.
main_pids() {
  pgrep -f "$(regex_escape "${APP_PATH}/Contents/MacOS/${APP_NAME}")( |\$)" 2>/dev/null || true
}

bundle_pids() {
  pgrep -f "$(regex_escape "${APP_PATH}/Contents/")" 2>/dev/null || true
}

policy_value() {
  /usr/libexec/PlistBuddy -c "Print ${POLICY_KEY}:$1" "$POLICY_PLIST" 2>/dev/null || true
}

running_app_policy() {
  local value
  value="$(policy_value runningApp)"
  case "$value" in
    replace|refuse) printf '%s' "$value" ;;
    "") printf 'refuse' ;;
    *)
      log "unknown installer.runningApp policy \"${value}\"; using refuse" >&2
      printf 'refuse'
      ;;
  esac
}

drain_timeout_seconds() {
  local value
  value="$(policy_value drainTimeoutSeconds)"
  if [ -z "$value" ]; then
    printf '%s' "$DEFAULT_DRAIN_TIMEOUT_SECONDS"
  elif ! [[ "$value" =~ ^[0-9]+$ ]]; then
    log "installer.drainTimeoutSeconds \"${value}\" is not a whole number; using ${DEFAULT_DRAIN_TIMEOUT_SECONDS}" >&2
    printf '%s' "$DEFAULT_DRAIN_TIMEOUT_SECONDS"
  elif [ "$value" -gt "$MAX_DRAIN_TIMEOUT_SECONDS" ]; then
    log "installer.drainTimeoutSeconds ${value} exceeds the ${MAX_DRAIN_TIMEOUT_SECONDS}s cap; using the cap" >&2
    printf '%s' "$MAX_DRAIN_TIMEOUT_SECONDS"
  else
    printf '%s' "$value"
  fi
}

# signal_main <signal>: send it to every main process still alive.
signal_main() {
  local pid
  for pid in $(main_pids); do
    kill "-$1" "$pid" 2>/dev/null || true
  done
}

# wait_for_exit <seconds>: 0 once no main process is left, 1 when the bound
# elapses first. WAITED_SECONDS carries how long it took.
wait_for_exit() {
  WAITED_SECONDS=0
  while [ -n "$(main_pids)" ]; do
    if [ "$WAITED_SECONDS" -ge "$1" ]; then
      return 1
    fi
    sleep 1
    WAITED_SECONDS=$((WAITED_SECONDS + 1))
  done
  return 0
}

# Stop a running Ion: the graceful drain first, the app's own forced quit when
# the drain bound elapses, SIGKILL only when that is ignored too.
stop_running_app() {
  local drain_timeout
  drain_timeout="$(drain_timeout_seconds)"

  log "requesting a graceful shutdown (SIGUSR1); drain bound ${drain_timeout}s."
  signal_main USR1
  if wait_for_exit "$drain_timeout"; then
    log "stop outcome: graceful; ${APP_NAME} drained and exited after ${WAITED_SECONDS}s."
    return 0
  fi

  log "drain bound of ${drain_timeout}s elapsed; forcing the quit (SIGUSR2)."
  signal_main USR2
  if wait_for_exit "$FORCED_QUIT_WAIT_SECONDS"; then
    log "stop outcome: forced; ${APP_NAME} quit ${WAITED_SECONDS}s after the forced quit, active work was stopped."
    return 0
  fi

  log "forced quit ignored for ${FORCED_QUIT_WAIT_SECONDS}s; terminating (SIGKILL)."
  signal_main KILL
  if wait_for_exit "$KILL_WAIT_SECONDS"; then
    log "stop outcome: killed; ${APP_NAME} was terminated."
    return 0
  fi

  log "stop outcome: failed; ${APP_NAME} is still running after SIGKILL."
  return 1
}

# A helper can outlive its main process briefly. Reap only processes running
# from the bundle being replaced.
reap_helpers() {
  local pids count
  pids="$(bundle_pids)"
  if [ -z "$pids" ]; then
    log "no helper processes left to reap."
    return 0
  fi
  count="$(printf '%s\n' "$pids" | wc -l | tr -d ' ')"
  # shellcheck disable=SC2086 # pgrep returns a whitespace-separated PID list.
  kill -9 $pids 2>/dev/null || true
  log "reaped ${count} helper process(es)."
}

# Leave no process running from the bundle, or return 1 when policy says a
# running Ion must be left alone.
ensure_app_stopped() {
  local pids policy
  pids="$(main_pids | tr '\n' ' ')"
  if [ -z "$pids" ]; then
    log "${APP_NAME} is not running."
    return 0
  fi

  policy="$(running_app_policy)"
  if [ "$policy" != "replace" ]; then
    log "${APP_NAME} is running (pid ${pids% }); refusing to replace the live application bundle."
    log "Quit ${APP_NAME}, then install again."
    return 1
  fi

  log "${APP_NAME} is running (pid ${pids% }); policy is replace."
  stop_running_app || return 1
  reap_helpers
}
