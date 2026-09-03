#!/bin/bash
# @file-size-exception: developer build script; commands document each package input
#
# Build Ion for local development, create the same .pkg used by manual installs,
# then dispatch a coordinator that waits for Ion's normal graceful quit before
# opening macOS Installer. The coordinator never writes /Applications itself.
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
ENGINE_OUT="resources/engine/ion"
mkdir -p "$(dirname "$ENGINE_OUT")"
ENGINE_VERSION="$(git -C ../engine describe --tags --always --dirty 2>/dev/null || echo dev)"
(
  cd ../engine
  go build -ldflags "-X main.version=${ENGINE_VERSION}" -o "../desktop/${ENGINE_OUT}" ./cmd/ion
)
chmod +x "$ENGINE_OUT"
codesign --force --sign - --identifier house.sprague.ion.engine --options runtime \
  --entitlements resources/entitlements.mac.plist "$ENGINE_OUT" 2>/dev/null || true
xattr -cr "$ENGINE_OUT" 2>/dev/null || true

mkdir -p resources/engine/extensions
rm -rf resources/engine/extensions/sdk resources/engine/extensions/sdk-go
cp -R ../engine/extensions/sdk resources/engine/extensions/sdk
cp -R ../sdk/go resources/engine/extensions/sdk-go
cp ../packaging/launchd/com.ion.engine.plist resources/engine/com.ion.engine.plist

print_section "Building Ion package"
npm run dist
npm run pkg

VERSION="$(node scripts/desktop-version.js)"
PACKAGE_PATH="release/Ion-${VERSION}.pkg"
[ -f "$PACKAGE_PATH" ] || { printf 'Package not found: %s\n' "$PACKAGE_PATH" >&2; exit 1; }

LOG="/tmp/ion-package-coordinator.log"
nohup bash commands/install-post-build.command "$PACKAGE_PATH" > "$LOG" 2>&1 &
disown

printf '\nBuild succeeded. Ion will finish active work, then open Installer.\n'
printf 'Coordinator log: %s\n' "$LOG"
