#!/bin/bash

# Resolve to repo root (one level up from commands/)
cd "$(dirname "$0")/.."

REPO_DIR="$(pwd)"
stopped=0

# ── Resolve PID ──

APP_PID=""

# Check packaged-app PID file
PACKAGED_PID_FILE="$HOME/Library/Application Support/CODA/coda.pid"
if [ -f "$PACKAGED_PID_FILE" ]; then
  APP_PID=$(cat "$PACKAGED_PID_FILE" 2>/dev/null)
fi

# Fallback: dev PID file
if [ -z "$APP_PID" ] || ! kill -0 "$APP_PID" 2>/dev/null; then
  if [ -f ".coda.pid" ]; then
    APP_PID=$(cat ".coda.pid" 2>/dev/null)
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
  rm -f ".coda.pid"
fi

# ── 2. Fallback: pattern-based kill for anything missed ──

leftover_pids=$(pgrep -f "$REPO_DIR/node_modules/electron" 2>/dev/null || true)
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
remaining=$(pgrep -f "$REPO_DIR/node_modules/electron" 2>/dev/null || true)
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
    echo "CODA stopped."
  else
    echo "CODA was not running."
  fi
fi
