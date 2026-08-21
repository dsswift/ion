#!/bin/bash
# Build a packaged local app with a truthful development identity. Release CI
# invokes electron-vite/electron-builder directly after stamping package.json.

set -euo pipefail

cd "$(dirname "$0")/.."

DESKTOP_VERSION="$(node scripts/desktop-version.js)"
echo "Development version: ${DESKTOP_VERSION}"

ION_DESKTOP_VERSION="${DESKTOP_VERSION}" npx electron-vite build --mode production
npx electron-builder --mac --dir \
  -c.extraMetadata.version="${DESKTOP_VERSION}" \
  -c.mac.bundleVersion="${DESKTOP_VERSION}"
