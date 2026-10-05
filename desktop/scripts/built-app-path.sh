#!/usr/bin/env bash
# built-app-path.sh — print the Ion.app electron-builder last produced.
#
# Usage: built-app-path.sh <release-dir>. Exits 1 with nothing printed when no
# build is there. electron-builder writes the app under release/mac,
# release/mac-universal, or release/mac-arm64 depending on the target arch; the
# first match wins.
set -euo pipefail

RELEASE_DIR="${1:?release directory is required}"

for candidate in \
  "${RELEASE_DIR}/mac-universal/Ion.app" \
  "${RELEASE_DIR}/mac/Ion.app" \
  "${RELEASE_DIR}/mac-arm64/Ion.app" \
  "${RELEASE_DIR}/mac-x64/Ion.app"; do
  if [ -d "${candidate}" ]; then
    printf '%s\n' "${candidate}"
    exit 0
  fi
done
exit 1
