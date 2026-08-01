#!/bin/bash
# Build in the foreground so errors are visible, then dispatch
# the kill/install/relaunch steps as a detached background process
# (critical for self-development inside Ion).

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
echo "═══ Building Ion Engine into desktop resources ═══"
echo

ENGINE_OUT="resources/engine/ion"
mkdir -p "resources/engine"
# Stamp main.version so `ion version` reports a real identifier instead of the
# "dev" default (parity with the CI release build; observability, not a swap
# gate — the daemon is swapped by binary hash in engine-bootstrap.ts).
ENGINE_VERSION="$(git -C ../engine describe --tags --always --dirty 2>/dev/null || echo dev)"
if ! (cd ../engine && go build -ldflags "-X main.version=${ENGINE_VERSION}" -o "../desktop/${ENGINE_OUT}" ./cmd/ion); then
  echo
  echo "Engine build failed."
  exit 1
fi
chmod +x "${ENGINE_OUT}"
# Sign with the SAME stable identifier and hardened runtime that afterPack.js
# uses for the packaged copy. The default filename-derived "ion" identifier is
# poisoned in the SIP-locked NetworkExtension policy store (see afterPack.js and
# engine/commands/install.command), which silently suppresses the macOS Local
# Network grant; keep local and packaged engine identity consistent.
codesign --force --sign - --identifier house.sprague.ion.engine --options runtime \
  --entitlements resources/entitlements.mac.plist "${ENGINE_OUT}" 2>/dev/null || true
xattr -cr "${ENGINE_OUT}" 2>/dev/null || true
echo "Engine built: ${ENGINE_OUT}"

# Bundle the extension SDK and plist so the packaged .app replicates the
# install.command bootstrap.
echo "Bundling engine extensions and plist into resources..."
mkdir -p resources/engine/extensions
# Delete-first so rebuilds replace rather than nest: `cp -r src dst` with an
# existing dst copies src INTO it (dst/sdk/sdk), permanently freezing the
# top-level copy at whatever the first build shipped.
rm -rf resources/engine/extensions/sdk
cp -r ../engine/extensions/sdk resources/engine/extensions/sdk

cp ../packaging/launchd/com.ion.engine.plist resources/engine/com.ion.engine.plist
echo "Extensions and plist bundled."

echo
echo "═══ Building Ion.app ═══"
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

LOG="/tmp/ion-install.log"
nohup bash commands/install-post-build.command > "$LOG" 2>&1 &
disown

echo
echo "Build succeeded. Install dispatched (log: $LOG)."
