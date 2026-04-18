#!/usr/bin/env bash
set -euo pipefail

ELECTRON_APP="node_modules/electron/dist/Electron.app"
RESOURCES="$ELECTRON_APP/Contents/Resources"
ICON_SRC="resources/icon.icns"

# Only run on macOS
[[ "$(uname)" == "Darwin" ]] || exit 0

# Only run if source icon exists
[[ -f "$ICON_SRC" ]] || exit 0

# Replace the icon
cp "$ICON_SRC" "$RESOURCES/electron.icns"

# Touch the bundle to invalidate macOS icon cache
touch "$ELECTRON_APP"

# Re-sign with ad-hoc signature (required after modifying bundle contents)
codesign --force --deep --sign - "$ELECTRON_APP" 2>/dev/null || true
