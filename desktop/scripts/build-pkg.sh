#!/usr/bin/env bash
# @file-size-exception: build script; length is inline documentation, not logic
#
# build-pkg.sh — wrap the built Ion.app into a macOS installer .pkg for MDM
# (Intune) deployment. This is the last Orion Phase 1 deployment artifact
# (D-003): the dmg/zip targets electron-builder produces are user-download
# installers; MDM push channels require a flat .pkg with a component payload.
#
# What it does:
#   1. Locates the built Ion.app (electron-builder writes it under release/mac*
#      for the --dir / dmg targets).
#   2. Reads the version from package.json (single source of truth).
#   3. Runs pkgbuild to produce release/Ion-<version>.pkg that installs the app
#      to /Applications. pkgbuild's component-install semantics REPLACE any
#      existing /Applications/Ion.app, which satisfies feature 0009 Scenario 1
#      (force-overwrite on reinstall) for free.
#   4. Embeds pkg-scripts/ so the package carries a preinstall that quits a
#      running Ion before overwriting its bundle. Replacing a live app bundle
#      corrupts the running process and fails the install; the preinstall sends
#      SIGUSR1 (the app's graceful-drain signal), waits, then force-quits. It
#      always exits 0, so a not-running app never blocks the install.
#
# Note: the .dmg target cannot do this. A DMG is a drag-to-Applications disk
# image with no install-time hook (electron-builder's dmg options expose no
# script key), so Finder performs the copy and no project code runs. Users
# updating in place should use the in-app updater, which quits before swapping
# the bundle (src/main/updater.ts).
#
# Prerequisites: a built Ion.app. Produce one with:
#     cd desktop && npm run dist            # builds release/mac*/Ion.app
#   (or the full make desktop, though that also installs+relaunches).
#
# Signing/notarization: the .app is already signed by electron-builder's mac
# pipeline (hardenedRuntime + entitlements). pkgbuild here produces an
# unsigned installer wrapper; to distribute via MDM, sign it with:
#     productsign --sign "Developer ID Installer: <team>" in.pkg out.pkg
# and notarize with `xcrun notarytool submit`. Signing identity selection is
# the operator's gitops (out of scope for this script).
#
# Sanity check after building (documented, not run here — it can prompt):
#     installer -pkg release/Ion-<version>.pkg -target / -dumplog -verbose
#   A dry inspection without installing:
#     pkgutil --payload-files release/Ion-<version>.pkg | head

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RELEASE_DIR="${DESKTOP_DIR}/release"

APP_IDENTIFIER="com.sprague.ion.desktop"
APP_NAME="Ion.app"

log() { printf '[build-pkg] %s\n' "$1"; }
die() { printf '[build-pkg] ERROR: %s\n' "$1" >&2; exit 1; }

command -v pkgbuild >/dev/null 2>&1 || die "pkgbuild not found (macOS command line tools required)"

# --- Locate the built Ion.app ------------------------------------------------
# electron-builder writes the app under release/mac, release/mac-universal, or
# release/mac-arm64 depending on the target arch. Take the first match.
APP_PATH=""
for candidate in \
  "${RELEASE_DIR}/mac-universal/${APP_NAME}" \
  "${RELEASE_DIR}/mac/${APP_NAME}" \
  "${RELEASE_DIR}/mac-arm64/${APP_NAME}" \
  "${RELEASE_DIR}/mac-x64/${APP_NAME}"; do
  if [ -d "${candidate}" ]; then
    APP_PATH="${candidate}"
    break
  fi
done

[ -n "${APP_PATH}" ] || die "no built ${APP_NAME} found under ${RELEASE_DIR}/mac*. Run 'npm run dist' first."
log "found app: ${APP_PATH}"

# --- Version from built app metadata -----------------------------------------
# The app is authoritative: release CI stamps release SemVer, while local dist
# stamps the next development SemVer plus commit identity in CFBundleShortVersionString.
APP_PLIST="${APP_PATH}/Contents/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP_PLIST}")"
[ -n "${VERSION}" ] || die "could not read version from built app metadata"
log "version:   ${VERSION}"

OUT_PKG="${RELEASE_DIR}/Ion-${VERSION}.pkg"

# --- Build the component .pkg ------------------------------------------------
# --component packages the app as a single component payload.
# --install-location /Applications makes the installer place (and replace)
# Ion.app there. --identifier + --version tag the package for MDM tracking.
# --scripts embeds pkg-scripts/, whose preinstall quits a running Ion before the
# payload is written (installing over a live bundle crashes or fails). The
# script exits 0 when Ion is not running, so it never blocks an install.
pkgbuild \
  --component "${APP_PATH}" \
  --install-location "/Applications" \
  --identifier "${APP_IDENTIFIER}" \
  --version "${VERSION}" \
  --scripts "${SCRIPT_DIR}/pkg-scripts" \
  "${OUT_PKG}"

log "built installer: ${OUT_PKG}"
log "verify (no install): pkgutil --payload-files \"${OUT_PKG}\" | head"
log "dry-run install:     installer -pkg \"${OUT_PKG}\" -target / -dumplog -verbose"
