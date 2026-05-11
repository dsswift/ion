#!/bin/bash
# Build IonRemote and install to a connected iPhone.
# Usage: bash commands/install.command [--device DEVICE_ID] [--release]
#
# Supports two install paths:
#   1. CoreDevice tunnel available → xcodebuild builds with device destination
#   2. Tunnel unavailable but usbmuxd reachable → generic build + ios-deploy
#
# Requires: Xcode CLI tools. Optional: ios-deploy (brew install ios-deploy).

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

# ── Detect device ──
# Populates: DEVICE_ID, TUNNEL_OK, LEGACY_UDID
TUNNEL_OK=false
LEGACY_UDID=""

detect_device() {
  echo "==> Detecting connected iPhone..."

  # Try devicectl (CoreDevice) first — modern Xcode 15+
  local tmp
  tmp=$(mktemp /tmp/devicectl.XXXXXX.json)
  xcrun devicectl list devices --json-output "$tmp" >/dev/null 2>&1 || true

  if [[ -s "$tmp" ]]; then
    local result
    result=$(python3 -c "
import json
data = json.load(open('$tmp'))
for d in data.get('result', {}).get('devices', []):
    hw = d.get('hardwareProperties', {})
    if hw.get('reality') != 'physical' or hw.get('deviceType') != 'iPhone':
        continue
    conn = d.get('connectionProperties', {})
    props = d.get('deviceProperties', {})
    udid = d.get('identifier', '')
    name = props.get('name', hw.get('marketingName', 'iPhone'))
    tunnel = conn.get('tunnelState', 'unavailable')
    ok = 'yes' if tunnel not in ['unavailable'] else 'no'
    print(f'{ok}|{udid}|{name}')
    break
" 2>/dev/null || true)
    rm -f "$tmp"

    if [[ -n "$result" ]]; then
      TUNNEL_OK=$( [[ "$(echo "$result" | cut -d'|' -f1)" == "yes" ]] && echo true || echo false )
      DEVICE_ID=$(echo "$result" | cut -d'|' -f2)
      local name
      name=$(echo "$result" | cut -d'|' -f3)
      echo "  Found: $name ($DEVICE_ID)"
      if $TUNNEL_OK; then
        echo "  Tunnel: available ✓"
      else
        echo "  Tunnel: unavailable (will use ios-deploy fallback)"
      fi
      return
    fi
  else
    rm -f "$tmp"
  fi

  # Fallback: xctrace (older Xcode or devicectl returned nothing)
  local line
  line=$(xcrun xctrace list devices 2>/dev/null \
    | grep -v "Simulator" \
    | grep -v "^==" \
    | grep -v "^$" \
    | grep -vE "^$(scutil --get ComputerName 2>/dev/null || hostname -s)" \
    | head -1)

  if [[ -z "$line" ]]; then
    echo "✗ No connected iPhone found."
    echo "  Connect via USB or ensure Wi-Fi pairing is active."
    exit 1
  fi

  DEVICE_ID=$(echo "$line" | grep -oE '[0-9A-Fa-f-]{20,}' | tail -1)
  if [[ -z "$DEVICE_ID" ]]; then
    echo "✗ Could not parse device ID from: $line"
    exit 1
  fi

  local dev_name
  dev_name=$(echo "$line" | sed 's/ (.*//')
  echo "  Found: $dev_name ($DEVICE_ID)"
  echo "  Tunnel: unknown (xctrace fallback)"
}

# Resolve legacy UDID via usbmuxd (libimobiledevice) for ios-deploy
detect_legacy_udid() {
  if command -v idevice_id &>/dev/null; then
    LEGACY_UDID=$(idevice_id -l 2>/dev/null | head -1)
  fi
}

if [[ -z "$DEVICE_ID" ]]; then
  detect_device
fi

# ── Choose build strategy ──

# Always resolve the legacy UDID for the install step.  ios-deploy uses
# usbmuxd which needs the 40-char hex UDID, not the CoreDevice UUID.
detect_legacy_udid

if $TUNNEL_OK; then
  # CoreDevice tunnel works — build targeting the specific device
  DESTINATION="id=$DEVICE_ID"
else
  # Tunnel broken — build for generic iOS and install separately
  if [[ -z "$LEGACY_UDID" ]] && ! command -v ios-deploy &>/dev/null; then
    echo
    echo "✗ CoreDevice tunnel is unavailable and no fallback install tool found."
    echo
    echo "  Install ios-deploy:  brew install ios-deploy"
    echo "  Or fix the tunnel:   unplug/replug USB, open Xcode, wait for device prep."
    exit 1
  fi
  DESTINATION="generic/platform=iOS"
fi

# ── Build ──

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

# ── Install ──

echo
echo "═══ Installing to device ═══"
echo

# Find the most recently built .app in DerivedData.
find_newest_app() {
  find ~/Library/Developer/Xcode/DerivedData \
    -path "*/$SCHEME-*/$CONFIGURATION-iphoneos/$SCHEME.app" \
    -maxdepth 5 \
    -type d \
    2>/dev/null \
    | while read -r app_dir; do
        binary="$app_dir/$SCHEME"
        if [[ -f "$binary" ]]; then
          echo "$(stat -f '%m' "$binary") $app_dir"
        fi
      done \
    | sort -rn \
    | head -1 \
    | cut -d' ' -f2-
}

APP_PATH=$(find_newest_app)

if [[ -z "$APP_PATH" ]]; then
  echo "✗ Could not find built .app bundle in DerivedData."
  echo "  Expected: DerivedData/*/$CONFIGURATION-iphoneos/$SCHEME.app"
  exit 1
fi

echo "  App: $APP_PATH"

# Pick the best install method:
# - ios-deploy uses usbmuxd (works even when CoreDevice tunnel is down)
# - devicectl requires a working tunnel
INSTALL_ID="${LEGACY_UDID:-$DEVICE_ID}"

if command -v ios-deploy &>/dev/null; then
  echo "  Using ios-deploy (device: $INSTALL_ID)..."
  ios-deploy --id "$INSTALL_ID" --bundle "$APP_PATH" --no-wifi 2>&1 || {
    echo "  ios-deploy failed, trying devicectl..."
    xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH" 2>&1
  }
else
  echo "  Using devicectl..."
  xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH" 2>&1
fi

echo
echo "═══ IonRemote installed ═══"
echo "  Device: $INSTALL_ID"
echo "  Config: $CONFIGURATION"
echo "  Bundle: $BUNDLE_ID"
