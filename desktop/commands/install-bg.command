#!/bin/bash
# @file-size-exception: developer build script; commands document each build input
#
# Build Ion for local development, then dispatch a coordinator that waits for
# Ion's normal graceful quit and swaps the new Ion.app into /Applications as
# this user. Nothing prompts, so the whole cycle runs unattended.
set -euo pipefail

cd "$(dirname "$0")/.."

print_section() {
  printf '\n═══ %s ═══\n\n' "$1"
}

print_section "Setting up environment and dependencies"
bash ./commands/setup.command

print_section "Checking voice support"
if ! command -v whisperkit-cli >/dev/null 2>&1 \
  && ! command -v whisper-cli >/dev/null 2>&1 \
  && ! command -v whisper >/dev/null 2>&1; then
  printf '%s\n' 'Whisper is not installed. Voice input requires it.'
  printf '%s\n' 'Run: brew install whisperkit-cli'
  exit 1
fi

print_section "Building Ion Engine into desktop resources"
# Shared with `make desktop-pkg`, so an app built either way carries the
# engine from this checkout rather than whatever was staged last.
bash ../scripts/stage-engine-resources.sh

print_section "Building Ion.app"
npm run dist

# The coordinator may wait a long time for Ion to drain. It installs a copy of
# this build, so a later build into release/ cannot change what it installs.
BUILT_APP="$(bash scripts/built-app-path.sh release)" \
  || { printf 'No built Ion.app found under release/mac*\n' >&2; exit 1; }
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ion-dev-install.XXXXXX")"
ditto "$BUILT_APP" "$STAGING_DIR/Ion.app"

LOG="/tmp/ion-install-coordinator.log"
nohup bash commands/install-post-build.command "$STAGING_DIR" > "$LOG" 2>&1 &
disown

printf '\nBuild succeeded. Ion will finish active work, quit, and reopen on the new build.\n'
printf 'Coordinator log: %s\n' "$HOME/.ion/dev-install-coordinator.log"
printf 'Install log:     %s\n' "$HOME/.ion/install-worker.jsonl"
