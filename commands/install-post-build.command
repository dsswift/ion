#!/bin/bash
# ──────────────────────────────────────────────────────
#  CODA — Post-Build Install
#
#  Runs after a successful build to:
#   1. Kill the running instance (graceful drain)
#   2. Copy the built app to /Applications
#   3. Clean temporary build files
#   4. Relaunch
#
#  This script is designed to run detached so that
#  CODA can install itself without deadlocking.
# ──────────────────────────────────────────────────────
set -e

cd "$(dirname "$0")/.."

APP_NAME="CODA"
DEST="/Applications/${APP_NAME}.app"

step() { echo; echo "═══ $1 ═══"; echo; }

# ── 1. Graceful shutdown ──

step "Step 1/3 — Stopping running instance"

APP_PID=""

# Check packaged-app PID file (written by Electron main process)
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

# Fallback: pgrep
if [ -z "$APP_PID" ] || ! kill -0 "$APP_PID" 2>/dev/null; then
  APP_PID=$(pgrep -f "CODA.app/Contents/MacOS/CODA$" 2>/dev/null | head -1 || true)
fi

if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
  echo "Signaling ${APP_NAME} to finish active agents and quit..."
  kill -USR1 "$APP_PID" 2>/dev/null || true

  # Wait up to 5 minutes for graceful exit
  TIMEOUT=300
  WAITED=0
  while kill -0 "$APP_PID" 2>/dev/null && [ "$WAITED" -lt "$TIMEOUT" ]; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ $((WAITED % 15)) -eq 0 ]; then
      echo "  Waiting for agents to finish... (${WAITED}s)"
    fi
  done

  if kill -0 "$APP_PID" 2>/dev/null; then
    echo "Timeout — force killing ${APP_NAME}"
    kill -9 "$APP_PID" 2>/dev/null || true
    sleep 1
  else
    echo "${APP_NAME} shut down gracefully."
  fi
fi

# Kill any stray helper processes (GPU, network, audio)
STRAY_PIDS=$(pgrep -f "CODA.app/Contents" 2>/dev/null || true)
if [ -n "$STRAY_PIDS" ]; then
  kill -9 $STRAY_PIDS 2>/dev/null || true
  sleep 1
fi

# ── 2. Copy to /Applications ──

step "Step 2/3 — Installing to /Applications"

APP_SOURCE=""
if [ -d "release/mac-arm64/${APP_NAME}.app" ]; then
  APP_SOURCE="release/mac-arm64/${APP_NAME}.app"
elif [ -d "release/mac/${APP_NAME}.app" ]; then
  APP_SOURCE="release/mac/${APP_NAME}.app"
fi

if [ -z "$APP_SOURCE" ]; then
  echo "Could not find the built app."
  echo
  echo "  Expected one of:"
  echo "    release/mac-arm64/${APP_NAME}.app  (Apple Silicon)"
  echo "    release/mac/${APP_NAME}.app        (Intel)"
  echo
  echo "  Check what was built:"
  echo "    ls release/"
  echo
  exit 1
fi

echo "Found: $APP_SOURCE"

if [ -d "$DEST" ]; then
  echo "Replacing existing ${APP_NAME} in /Applications..."
  rm -rf "$DEST"
fi

cp -R "$APP_SOURCE" "$DEST"
echo "Copied to $DEST"

# ── 3. Cleanup + Launch ──

step "Step 3/3 — Cleaning up and launching"

if [ "${KEEP_BUILD_ARTIFACTS:-0}" = "1" ]; then
  echo "Keeping build artifacts (KEEP_BUILD_ARTIFACTS=1)."
else
  rm -rf ./dist ./release
  echo "Removed: dist/ and release/"
fi

open "$DEST"

echo "Done! ${APP_NAME} is running."
echo
echo "  Show/hide the overlay:  ⌥ + Space  (Option + Space)"
echo "  Quit:                   Click the menu bar icon > Quit"
echo
