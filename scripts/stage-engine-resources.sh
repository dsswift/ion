#!/usr/bin/env bash
# stage-engine-resources.sh -- build this checkout's engine into
# desktop/resources/engine/, where electron-builder picks it up.
#
# Every path that produces an Ion.app runs this first, so the app always
# carries the engine from the same commit as the desktop code. It exists as
# its own script because it used to live only inside the interactive
# `make desktop` flow: `make desktop-pkg` built the app around whatever
# engine binary happened to be staged from an earlier day, and shipped an
# installer whose engine predated the branch.
#
# usage: scripts/stage-engine-resources.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/desktop/resources/engine/ion"
# ION_ENGINE_VERSION: a tree shipped without its git history (an ion fleet
# builder host) is told the version the checkout it came from describes.
VERSION="${ION_ENGINE_VERSION:-$(git -C "$REPO_ROOT/engine" describe --tags --always --dirty 2>/dev/null || echo dev)}"

mkdir -p "$(dirname "$OUT")"
echo "==> building engine $VERSION into desktop/resources/engine/ion"
(cd "$REPO_ROOT/engine" && go build -ldflags "-X main.version=${VERSION}" -o "$OUT" ./cmd/ion)
chmod +x "$OUT"

# Ad-hoc signature + no quarantine attributes, so the bundled engine runs on
# the machine that built it before electron-builder signs the whole app.
codesign --force --sign - --identifier house.sprague.ion.engine --options runtime \
  --entitlements "$REPO_ROOT/desktop/resources/entitlements.mac.plist" "$OUT" 2>/dev/null || true
xattr -cr "$OUT" 2>/dev/null || true

RES="$REPO_ROOT/desktop/resources/engine"
mkdir -p "$RES/extensions"
rm -rf "$RES/extensions/sdk" "$RES/extensions/sdk-go"
cp -R "$REPO_ROOT/engine/extensions/sdk" "$RES/extensions/sdk"
cp -R "$REPO_ROOT/sdk/go" "$RES/extensions/sdk-go"
cp "$REPO_ROOT/packaging/launchd/com.ion.engine.plist" "$RES/com.ion.engine.plist"

echo "==> staged: $("$OUT" version)"
