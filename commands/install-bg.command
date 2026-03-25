#!/bin/bash
# Build in the foreground so errors are visible, then dispatch
# the kill/install/relaunch steps as a detached background process
# (critical for self-development inside CODA).

set -e

cd "$(dirname "$0")/.."

# ── Setup + Build (foreground — output visible to caller) ──

echo
echo "═══ Setting up environment and dependencies ═══"
echo

if ! bash ./commands/setup.command; then
  echo
  echo "Setup failed. Fix the issues above and retry."
  exit 1
fi

echo
echo "═══ Checking voice support (Whisper) ═══"
echo

if command -v whisperkit-cli &>/dev/null || command -v whisper-cli &>/dev/null || command -v whisper &>/dev/null; then
  echo "Whisper is already installed."
else
  echo "Whisper is not installed. Voice input requires it."
  echo "  Run: brew install whisperkit-cli"
  exit 1
fi

echo
echo "═══ Building CODA.app ═══"
echo

if ! npm run dist; then
  echo
  echo "Build failed."
  echo
  echo "  Try these steps one at a time:"
  echo "    rm -rf node_modules"
  echo "    npm install"
  echo "    npm run dist"
  echo
  exit 1
fi

# ── Post-build (detached background — survives parent being killed) ──

LOG="/tmp/coda-install.log"
nohup bash commands/install-post-build.command > "$LOG" 2>&1 &
disown

echo
echo "Build succeeded. Install dispatched (log: $LOG)."
