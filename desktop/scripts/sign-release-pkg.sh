#!/usr/bin/env bash
# Sign, notarize, and verify a macOS installer before release upload.
set -euo pipefail

log() { printf '[sign-release-pkg] %s\n' "$1"; }
die() { printf '[sign-release-pkg] ERROR: %s\n' "$1" >&2; exit 1; }
require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || die "${name} is required for a release package"
}

[ "$#" -eq 1 ] || die "usage: $0 <package.pkg>"
PKG_PATH="$1"
[ -f "$PKG_PATH" ] || die "package not found: ${PKG_PATH}"
[[ "$PKG_PATH" == *.pkg ]] || die "package must have a .pkg extension: ${PKG_PATH}"

require_env APPLE_INSTALLER_IDENTITY
require_env APPLE_API_KEY
require_env APPLE_API_KEY_ID
require_env APPLE_API_ISSUER

for command in productsign xcrun pkgutil spctl; do
  command -v "$command" >/dev/null 2>&1 || die "${command} not found"
done

SIGNED_PKG="${PKG_PATH%.pkg}-signed.pkg"
KEY_FILE="$(mktemp /tmp/ion-notary-key.XXXXXX.p8)"
cleanup() {
  rm -f "$KEY_FILE" "$SIGNED_PKG"
}
trap cleanup EXIT

log "signing package"
productsign --sign "$APPLE_INSTALLER_IDENTITY" "$PKG_PATH" "$SIGNED_PKG"
mv -f "$SIGNED_PKG" "$PKG_PATH"

log "submitting package to Apple notary service"
printf '%s' "$APPLE_API_KEY" | base64 --decode > "$KEY_FILE"
xcrun notarytool submit "$PKG_PATH" \
  --key "$KEY_FILE" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" \
  --wait \
  --timeout 15m

log "stapling notarization ticket"
xcrun stapler staple "$PKG_PATH"
xcrun stapler validate "$PKG_PATH"

log "verifying installer signature"
SIGNATURE_OUTPUT="$(pkgutil --check-signature "$PKG_PATH")"
printf '%s\n' "$SIGNATURE_OUTPUT"
grep -q "Developer ID Installer" <<< "$SIGNATURE_OUTPUT" || \
  die "package does not have a Developer ID Installer signature"

log "checking Gatekeeper acceptance"
spctl -a -vvv -t install "$PKG_PATH"
log "release package passed signing, notarization, and Gatekeeper checks"
