#!/usr/bin/env bash
# @file-size-exception: build script; length is inline documentation, not logic
#
# build-pkg.sh — wrap the built Ion.app into a macOS installer .pkg for MDM
# (Intune) deployment. electron-builder produces the release zip for auto-update and this
# package for every human or managed install.
#
# What it does:
#   1. Locates the built Ion.app under electron-builder's release/mac* output.
#   2. Reads the version from package.json (single source of truth).
#   3. Runs pkgbuild to produce release/Ion-<version>.pkg. The payload lands
#      in a staging directory, and pkg-scripts/postinstall swaps the complete
#      bundle into /Applications/Ion.app, replacing any existing copy
#      (feature 0009 Scenario 1, force-overwrite on reinstall).
#   4. Embeds pkg-scripts/. By default the package refuses to replace a running
#      Ion and its log tells the operator to quit Ion and retry. Device policy
#      can select the unattended path, which stops a running Ion first.
#
# Prerequisites: a built Ion.app. Produce one with:
#     cd desktop && npm run dist            # builds release/mac*/Ion.app
#
# Signing/notarization: the .app is already signed by electron-builder's mac
# pipeline (hardenedRuntime + entitlements). This script produces the unsigned
# installer input. Release CI must pass it through sign-release-pkg.sh before
# upload. Local builds remain unsigned and are for development only.
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
# Must match STAGING_DIR in pkg-scripts/ion-pkg-common.sh.
STAGING_DIR="/Library/Application Support/Ion/pkg-staging"

log() { printf '[build-pkg] %s\n' "$1"; }
die() { printf '[build-pkg] ERROR: %s\n' "$1" >&2; exit 1; }

command -v pkgbuild >/dev/null 2>&1 || die "pkgbuild not found (macOS command line tools required)"

# --- Locate the built Ion.app ------------------------------------------------
APP_PATH="$(bash "${SCRIPT_DIR}/built-app-path.sh" "${RELEASE_DIR}" || true)"
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
# The payload root holds Ion.app alone, so the package installs exactly one
# bundle into the staging directory postinstall swaps from.
PAYLOAD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ion-pkg-root.XXXXXX")"
trap 'rm -rf "${PAYLOAD_ROOT}"' EXIT
ditto "${APP_PATH}" "${PAYLOAD_ROOT}/root/${APP_NAME}"

# Installer must write the bundle where the package says, every time: never
# follow a copy of Ion found elsewhere on the disk, and never skip the payload
# because of the version already installed (a pinned fleet rolls back too).
COMPONENT_PLIST="${PAYLOAD_ROOT}/component.plist"
pkgbuild --analyze --root "${PAYLOAD_ROOT}/root" "${COMPONENT_PLIST}" >/dev/null
/usr/libexec/PlistBuddy \
  -c 'Delete :0:BundleIsRelocatable' \
  -c 'Add :0:BundleIsRelocatable bool false' \
  -c 'Set :0:BundleIsVersionChecked false' \
  "${COMPONENT_PLIST}" >/dev/null 2>&1 || true
[ "$(/usr/libexec/PlistBuddy -c 'Print :0:BundleIsRelocatable' "${COMPONENT_PLIST}")" = "false" ] \
  || die "component plist is still relocatable"
[ "$(/usr/libexec/PlistBuddy -c 'Print :0:BundleIsVersionChecked' "${COMPONENT_PLIST}")" = "false" ] \
  || die "component plist is still version-checked"

# --identifier + --version tag the package for MDM tracking. --scripts embeds
# the running-Ion preflight and the swap into /Applications.
pkgbuild \
  --root "${PAYLOAD_ROOT}/root" \
  --component-plist "${COMPONENT_PLIST}" \
  --install-location "${STAGING_DIR}" \
  --identifier "${APP_IDENTIFIER}" \
  --version "${VERSION}" \
  --scripts "${SCRIPT_DIR}/pkg-scripts" \
  "${OUT_PKG}"

log "built installer: ${OUT_PKG}"
log "verify (no install): pkgutil --payload-files \"${OUT_PKG}\" | head"
log "dry-run install:     installer -pkg \"${OUT_PKG}\" -target / -dumplog -verbose"
