#!/bin/bash
# Build IonRemote and install to a connected iOS device (iPhone or iPad).
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
# Populates: DEVICE_ID, TUNNEL_OK, INSTALL_ALL, ALL_DEVICES
TUNNEL_OK=false
INSTALL_ALL=false
ALL_DEVICES=""

detect_device() {
  echo "==> Detecting connected iOS device..."

  # Try devicectl (CoreDevice) first — modern Xcode 15+
  local tmp
  tmp=$(mktemp /tmp/devicectl.XXXXXX.json)
  xcrun devicectl list devices --json-output "$tmp" >/dev/null 2>&1 || true

  if [[ -s "$tmp" ]]; then
    # Collect physical iOS devices with an active connection (wired or network)
    local devices
    devices=$(python3 -c "
import json
data = json.load(open('$tmp'))
results = []
for d in data.get('result', {}).get('devices', []):
    hw = d.get('hardwareProperties', {})
    if hw.get('reality') != 'physical':
        continue
    dtype = hw.get('deviceType', '')
    if dtype not in ('iPhone', 'iPad'):
        continue
    conn = d.get('connectionProperties', {})
    tunnel = conn.get('tunnelState', 'unavailable')
    transport = conn.get('transportType', '')
    # Keep devices with an active tunnel, or a known transport (wired/localNetwork).
    # Devices with no transportType and no tunnel are stale pairings.
    if tunnel != 'connected' and transport == '':
        continue
    props = d.get('deviceProperties', {})
    udid = d.get('identifier', '')
    name = props.get('name', hw.get('marketingName', dtype))
    ok = 'yes' if tunnel == 'connected' else 'no'
    results.append(f'{ok}|{udid}|{name}|{dtype}')
for r in results:
    print(r)
" 2>/dev/null || true)
    rm -f "$tmp"

    if [[ -n "$devices" ]]; then
      local count
      count=$(echo "$devices" | wc -l | tr -d ' ')

      if [[ "$count" -gt 1 ]]; then
        echo "  Multiple devices connected:"
        echo
        local i=1
        while IFS= read -r dev; do
          local dname dtype
          dname=$(echo "$dev" | cut -d'|' -f3)
          dtype=$(echo "$dev" | cut -d'|' -f4)
          echo "    $i) $dname ($dtype)"
          i=$((i + 1))
        done <<< "$devices"
        echo "    a) All devices"
        echo
        printf "  Select device [1-%d/a]: " "$count"
        read -r choice
        if [[ "$choice" == "a" || "$choice" == "A" ]]; then
          INSTALL_ALL=true
          ALL_DEVICES="$devices"
          # Use the first device for the build destination
          devices=$(echo "$devices" | head -1)
        elif [[ -z "$choice" ]] || [[ "$choice" -lt 1 ]] || [[ "$choice" -gt "$count" ]]; then
          choice=1
          devices=$(echo "$devices" | sed -n "${choice}p")
        else
          devices=$(echo "$devices" | sed -n "${choice}p")
        fi
      fi

      TUNNEL_OK=$( [[ "$(echo "$devices" | cut -d'|' -f1)" == "yes" ]] && echo true || echo false )
      DEVICE_ID=$(echo "$devices" | cut -d'|' -f2)
      local name dtype
      name=$(echo "$devices" | cut -d'|' -f3)
      dtype=$(echo "$devices" | cut -d'|' -f4)
      if $INSTALL_ALL; then
        echo "  Installing to all $count devices (building for first: $name)"
      else
        echo "  Found: $name ($dtype, $DEVICE_ID)"
      fi
      if $TUNNEL_OK; then
        echo "  Tunnel: available ✓"
      else
        echo "  Tunnel: unavailable (will use ios-deploy fallback)"
      fi
      return
    fi

    # devicectl worked but no active device found — don't fall through
    echo "✗ No connected iOS device found."
    echo "  Paired devices exist but none have an active tunnel or USB connection."
    echo "  Connect an iPhone or iPad via USB cable."
    exit 1
  else
    rm -f "$tmp"
  fi

  # Fallback: xctrace (older Xcode or devicectl failed to produce output)
  local line
  line=$(xcrun xctrace list devices 2>/dev/null \
    | grep -v "Simulator" \
    | grep -v "^==" \
    | grep -v "^$" \
    | grep -vE "^$(scutil --get ComputerName 2>/dev/null || hostname -s)" \
    | head -1)

  if [[ -z "$line" ]]; then
    echo "✗ No connected iOS device found."
    echo "  Connect an iPhone or iPad via USB or ensure Wi-Fi pairing is active."
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

if [[ -z "$DEVICE_ID" ]]; then
  detect_device
fi

# ── Choose build strategy ──

if $TUNNEL_OK; then
  # CoreDevice tunnel works — build targeting the specific device
  DESTINATION="id=$DEVICE_ID"
else
  # Tunnel not fully up — build for generic iOS and install via devicectl
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

# Install to a single device. Args: $1=device_id
install_to_device() {
  local dev_id="$1"

  # Prefer devicectl — it handles both USB and network installs.
  echo "  Using devicectl (device: $dev_id)..."
  if xcrun devicectl device install app --device "$dev_id" "$APP_PATH" 2>&1; then
    return 0
  fi

  echo "  devicectl failed, trying ios-deploy..."
  if ! command -v ios-deploy &>/dev/null; then
    echo "  ✗ ios-deploy not installed. Install with: brew install ios-deploy"
    return 1
  fi

  # Resolve legacy UDID for ios-deploy (USB only)
  local legacy_id=""
  if command -v idevice_id &>/dev/null; then
    legacy_id=$(idevice_id -l 2>/dev/null | head -1)
  fi
  local install_id="${legacy_id:-$dev_id}"

  echo "  Using ios-deploy (device: $install_id)..."
  ios-deploy --id "$install_id" --bundle "$APP_PATH" --no-wifi 2>&1
}

if $INSTALL_ALL; then
  while IFS= read -r dev; do
    local_id=$(echo "$dev" | cut -d'|' -f2)
    local_name=$(echo "$dev" | cut -d'|' -f3)
    local_type=$(echo "$dev" | cut -d'|' -f4)
    echo
    echo "  → $local_name ($local_type)"
    install_to_device "$local_id"
  done <<< "$ALL_DEVICES"
else
  install_to_device "$DEVICE_ID"
fi

echo
echo "═══ IonRemote installed ═══"
if $INSTALL_ALL; then
  echo "  Devices: all connected"
else
  echo "  Device: $DEVICE_ID"
fi
echo "  Config: $CONFIGURATION"
echo "  Bundle: $BUNDLE_ID"
