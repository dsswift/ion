#!/bin/bash

# Resolve to repo root (one level up from commands/)
cd "$(dirname "$0")/.."

REPO_DIR="$(pwd)"
stopped=0

# ── Resolve PID ──

APP_PID=""

# Check packaged-app PID file
PACKAGED_PID_FILE="$HOME/Library/Application Support/Ion/ion.pid"
if [ -f "$PACKAGED_PID_FILE" ]; then
  APP_PID=$(cat "$PACKAGED_PID_FILE" 2>/dev/null)
fi

# Fallback: dev PID file
if [ -z "$APP_PID" ] || ! kill -0 "$APP_PID" 2>/dev/null; then
  if [ -f ".ion.pid" ]; then
    APP_PID=$(cat ".ion.pid" 2>/dev/null)
  fi
fi

# ── 1. Try graceful drain (SIGUSR1) then SIGTERM ──

if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
  # Signal drain mode — lets active agents finish
  kill -USR1 "$APP_PID" 2>/dev/null || true

  # Wait up to 10 seconds for graceful drain+quit
  for i in $(seq 1 10); do
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 1
  done

  # Escalate to SIGTERM if still alive
  if kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    for i in 1 2 3; do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 1
    done
  fi

  # Force kill if still alive
  if kill -0 "$APP_PID" 2>/dev/null; then
    kill -KILL "$APP_PID" 2>/dev/null || true
    sleep 0.5
  fi

  stopped=1
  rm -f ".ion.pid"
fi

# ── 2. Fallback: pattern-based kill for anything missed ──

# The electron binary a dev run launches lives wherever npm installed it,
# which under a workspace install is the repo root rather than desktop/.
ELECTRON_DIR=$(node -p "require('$REPO_DIR/scripts/resolve-package').packageDir('electron','$REPO_DIR') || ''" 2>/dev/null || echo "")

leftover_pids=""
if [ -n "$ELECTRON_DIR" ]; then
  leftover_pids=$(pgrep -f "$ELECTRON_DIR" 2>/dev/null || true)
fi
leftover_pids="$leftover_pids $(pgrep -f "$REPO_DIR/dist/main" 2>/dev/null || true)"
leftover_pids=$(echo "$leftover_pids" | xargs)

if [ -n "$leftover_pids" ]; then
  # Graceful first
  kill -TERM $leftover_pids 2>/dev/null
  sleep 2

  # Force kill survivors
  for pid in $leftover_pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null
    fi
  done
  stopped=1
fi

# ── 3. Verify ──

sleep 0.5
remaining=""
if [ -n "$ELECTRON_DIR" ]; then
  remaining=$(pgrep -f "$ELECTRON_DIR" 2>/dev/null || true)
fi
remaining="$remaining $(pgrep -f "$REPO_DIR/dist/main" 2>/dev/null || true)"
remaining=$(echo "$remaining" | xargs)

if [ -n "$remaining" ]; then
  echo "Warning: some processes could not be stopped:"
  echo "  PIDs: $remaining"
  echo
  echo "  To force kill manually:"
  echo "    kill -9 $remaining"
else
  if [ "$stopped" -eq 1 ]; then
    echo "Ion stopped."
  else
    echo "Ion was not running."
  fi
fi
