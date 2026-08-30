#!/usr/bin/env bash
# Regression tests for physical iOS device detection.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=ios/commands/install-device-detection.sh
source "$SCRIPT_DIR/install-device-detection.sh"

bash -n "$SCRIPT_DIR/install.command"
bash -n "$SCRIPT_DIR/install-device-detection.sh"

TMP_DIR="$(mktemp -d -t install-device-detection.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

STALE_JSON="$TMP_DIR/stale.json"
cat > "$STALE_JSON" <<'JSON'
{
  "result": {
    "devices": [
      {
        "identifier": "00000000-0000000000000000",
        "hardwareProperties": {"reality": "physical", "deviceType": "iPhone"},
        "deviceProperties": {"name": "Example Phone"},
        "connectionProperties": {"tunnelState": "unavailable"}
      }
    ]
  }
}
JSON

NETWORK_JSON="$TMP_DIR/network.json"
cat > "$NETWORK_JSON" <<'JSON'
{
  "result": {
    "devices": [
      {
        "identifier": "00000000-0000000000000002",
        "hardwareProperties": {"reality": "physical", "deviceType": "iPhone"},
        "deviceProperties": {"name": "Network Phone"},
        "connectionProperties": {
          "tunnelState": "disconnected",
          "transportType": "localNetwork"
        }
      }
    ]
  }
}
JSON

network_device=$(parse_active_devices_from_devicectl_json "$NETWORK_JSON")
expected_network='no|00000000-0000000000000002|Network Phone|iPhone|coredevice'
if [[ "$network_device" != "$expected_network" ]]; then
  echo "paired Wi-Fi device was not accepted for a CoreDevice install attempt" >&2
  exit 1
fi

mkdir -p "$TMP_DIR/bin"
cat > "$TMP_DIR/bin/ios-deploy" <<'SH'
#!/usr/bin/env bash
cat "$IOS_DEPLOY_FIXTURE"
SH
chmod +x "$TMP_DIR/bin/ios-deploy"
export PATH="$TMP_DIR/bin:$PATH"

USB_OUTPUT="$TMP_DIR/usb.txt"
cat > "$USB_OUTPUT" <<'OUTPUT'
[....] Found 00000000-0000000000000001 (Example1, Example1, iOS, arm64, 26.6, 23G00) a.k.a. 'Example Phone' connected through USB.
OUTPUT
export IOS_DEPLOY_FIXTURE="$USB_OUTPUT"

resolved=$(resolve_connected_devices "$STALE_JSON")
expected='no|00000000-0000000000000001|USB device 00000000|iPhone|legacy'
if [[ "$resolved" != "$expected" ]]; then
  echo "USB fallback did not return the connected legacy UDID" >&2
  exit 1
fi

DEVICE_ID="00000000-0000000000000001"
if [[ "$(build_destination_for_device false)" != "generic/platform=iOS" ]]; then
  echo "USB fallback did not preserve the generic iOS build destination" >&2
  exit 1
fi

NO_DEVICE_OUTPUT="$TMP_DIR/no-device.txt"
cat > "$NO_DEVICE_OUTPUT" <<'OUTPUT'
[....] Waiting up to 5 seconds for iOS device to be connected
OUTPUT
export IOS_DEPLOY_FIXTURE="$NO_DEVICE_OUTPUT"

if [[ -n "$(resolve_connected_devices "$STALE_JSON")" ]]; then
  echo "stale pairings were accepted without a connected USB device" >&2
  exit 1
fi

network_error=$(print_no_connected_device_error)
if [[ "$network_error" != *"CoreDevice tunnel"* ]] \
  || [[ "$network_error" != *"VPN,"* ]] \
  || [[ "$network_error" != *"local network access"* ]]; then
  echo "unavailable Wi-Fi connection did not produce an actionable error" >&2
  exit 1
fi

echo "install device detection checks: OK"
