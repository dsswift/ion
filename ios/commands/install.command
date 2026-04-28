#!/bin/bash
# Build IonRemote and install to a connected iPhone.
# Usage: bash commands/install.command [--device DEVICE_ID]
#
# Requires a connected iPhone (USB or Wi-Fi paired).
# Uses xcodebuild to build + install in one shot via
# `build install-on-device`.

set -euo pipefail

cd "$(dirname "$0")/.."

TEAM_ID="P6UU9VHF7D"
SCHEME="IonRemote"
PROJECT="IonRemote.xcodeproj"
BUNDLE_ID="com.sprague.ion.mobile"
CONFIGURATION="Debug"
DEVICE_ID=""

# ── Parse args ──

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      DEVICE_ID="$2"
      shift 2
      ;;
    --release)
      CONFIGURATION="Release"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: bash commands/install.command [--device DEVICE_ID] [--release]"
      exit 1
      ;;
  esac
done

# ── Find connected device ──

if [[ -z "$DEVICE_ID" ]]; then
  echo "==> Detecting connected iPhone..."

  # List physical devices (filter out simulators and this Mac)
  DEVICE_LINE=$(xcrun xctrace list devices 2>/dev/null \
    | grep -v "Simulator" \
    | grep -v "^==" \
    | grep -v "^$" \
    | grep -vE "^$(scutil --get ComputerName 2>/dev/null || hostname -s)" \
    | head -1)

  if [[ -z "$DEVICE_LINE" ]]; then
    echo "✗ No connected iPhone found."
    echo
    echo "  Connect an iPhone via USB or ensure Wi-Fi pairing is active."
    echo "  To list devices: xcrun xctrace list devices"
    exit 1
  fi

  # Extract device ID from parenthesized UDID at end of line
  DEVICE_ID=$(echo "$DEVICE_LINE" | grep -oE '[0-9A-Fa-f-]{20,}' | tail -1)

  if [[ -z "$DEVICE_ID" ]]; then
    echo "✗ Could not parse device ID from: $DEVICE_LINE"
    exit 1
  fi

  DEVICE_NAME=$(echo "$DEVICE_LINE" | sed 's/ (.*//') 
  echo "  Found: $DEVICE_NAME ($DEVICE_ID)"
fi

DESTINATION="id=$DEVICE_ID"

# ── Build + Install ──

echo
echo "═══ Building $SCHEME ($CONFIGURATION) ═══"
echo

xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "$DESTINATION" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  build 2>&1 | tail -5

BUILD_EXIT=${PIPESTATUS[0]}

if [[ $BUILD_EXIT -ne 0 ]]; then
  echo
  echo "✗ Build failed."
  exit 1
fi

echo
echo "═══ Installing to device ═══"
echo

# Use ios-deploy if available (faster, launches app), otherwise devicectl
if command -v ios-deploy &>/dev/null; then
  # Find the built .app in DerivedData
  APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData \
    -path "*/$SCHEME-*/$CONFIGURATION-iphoneos/$SCHEME.app" \
    -maxdepth 5 \
    -type d \
    2>/dev/null \
    | head -1)

  if [[ -z "$APP_PATH" ]]; then
    echo "✗ Could not find built .app bundle in DerivedData."
    echo "  Expected: DerivedData/*/$CONFIGURATION-iphoneos/$SCHEME.app"
    exit 1
  fi

  echo "  Using ios-deploy..."
  ios-deploy --id "$DEVICE_ID" --bundle "$APP_PATH" --no-wifi 2>&1 || {
    echo "  ios-deploy failed, falling back to devicectl..."
    xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH" 2>&1
  }
else
  # devicectl (Xcode 15+) — install from DerivedData
  APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData \
    -path "*/$SCHEME-*/$CONFIGURATION-iphoneos/$SCHEME.app" \
    -maxdepth 5 \
    -type d \
    2>/dev/null \
    | head -1)

  if [[ -z "$APP_PATH" ]]; then
    echo "✗ Could not find built .app bundle in DerivedData."
    echo "  Expected: DerivedData/*/$CONFIGURATION-iphoneos/$SCHEME.app"
    exit 1
  fi

  echo "  Using devicectl..."
  xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH" 2>&1
fi

echo
echo "═══ IonRemote installed ═══"
echo "  Device: $DEVICE_ID"
echo "  Config: $CONFIGURATION"
echo "  Bundle: $BUNDLE_ID"
