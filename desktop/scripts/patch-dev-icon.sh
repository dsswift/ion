#!/usr/bin/env bash
set -euo pipefail

ELECTRON_DIST="node_modules/electron/dist"
ELECTRON_APP="$ELECTRON_DIST/Electron.app"
RESOURCES="$ELECTRON_APP/Contents/Resources"
ICON_SRC="resources/icon.icns"
ELECTRON_INSTALL="node_modules/electron/install.js"

# Only run on macOS
[[ "$(uname)" == "Darwin" ]] || exit 0

# Only run if source icon exists
[[ -f "$ICON_SRC" ]] || exit 0

# Ensure the Electron binary is actually extracted. The `electron` npm package
# extracts its prebuilt binary into dist/ via its own postinstall (install.js).
# npm normally runs a dependency's postinstall before the root postinstall, so
# dist/ exists by the time we get here. But that ordering is not guaranteed: an
# interrupted install, a transient download failure, or a prior
# `npm ci --ignore-scripts` that left node_modules in place all produce an
# electron package whose dist/ was never populated. In that state the old
# `cp ... electron.icns` failed with a cryptic "No such file or directory" and
# hard-aborted the entire `npm install` (the postinstall chain is `&&`-joined),
# which setup.command then mis-reported as an Xcode/toolchain problem. Self-heal
# by running electron's own extractor instead of crashing the install.
if [[ ! -d "$ELECTRON_APP" ]]; then
  if [[ -f "$ELECTRON_INSTALL" ]]; then
    echo "patch-dev-icon: electron dist/ missing, running electron install.js to extract binary..."
    node "$ELECTRON_INSTALL"
  fi
  # If extraction still did not produce the bundle, skip the icon patch rather
  # than aborting the whole install. The icon swap is cosmetic (dev dock icon);
  # a missing electron binary is a separate, louder failure that electron-vite /
  # electron-builder will surface on their own.
  if [[ ! -d "$ELECTRON_APP" ]]; then
    echo "patch-dev-icon: electron dist/ still missing after install.js; skipping icon patch (non-fatal)." >&2
    exit 0
  fi
fi

# Replace the icon
cp "$ICON_SRC" "$RESOURCES/electron.icns"

# Touch the bundle to invalidate macOS icon cache
touch "$ELECTRON_APP"

# Re-sign with ad-hoc signature (required after modifying bundle contents)
codesign --force --deep --sign - "$ELECTRON_APP" 2>/dev/null || true
