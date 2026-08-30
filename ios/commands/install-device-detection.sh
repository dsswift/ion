#!/usr/bin/env bash
# Device-detection helpers for install.command.

# Parse devicectl JSON and print active candidates as:
# tunnel_ok|coredevice_id|name|device_type|coredevice
# tunnel_ok is "yes" only when tunnelState == connected.
parse_active_devices_from_devicectl_json() {
  local json_path="$1"
  python3 - "$json_path" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)

for d in data.get("result", {}).get("devices", []):
    hw = d.get("hardwareProperties", {})
    if hw.get("reality") != "physical":
        continue
    dtype = hw.get("deviceType", "")
    if dtype not in ("iPhone", "iPad"):
        continue
    conn = d.get("connectionProperties", {})
    tunnel = conn.get("tunnelState", "unavailable")
    transport = conn.get("transportType", "")
    # Keep only actively connected devices from devicectl.
    # Entries with no tunnel and no transport are stale pairings.
    if tunnel != "connected" and transport == "":
        continue
    props = d.get("deviceProperties", {})
    core_id = d.get("identifier", "")
    name = props.get("name", hw.get("marketingName", dtype))
    tunnel_ok = "yes" if tunnel == "connected" else "no"
    print(f"{tunnel_ok}|{core_id}|{name}|{dtype}|coredevice")
PY
}

# Print connected USB legacy UDIDs from ios-deploy as:
# no|legacy_udid|USB device <short>|iPhone|legacy
# tunnel_ok is always "no" for this fallback path.
list_usb_devices_from_ios_deploy() {
  if ! command -v ios-deploy >/dev/null 2>&1; then
    return 0
  fi

  ios-deploy -c 2>&1 \
    | sed -nE 's/.*Found ([0-9A-Fa-f-]{20,}) .* connected through USB\..*/\1/p' \
    | awk '{printf "no|%s|USB device %.8s|iPhone|legacy\n", $1, $1}' \
    | awk '!seen[$0]++'
}

# Prefer active CoreDevice records. When devicectl only reports stale pairings,
# use the devices that ios-deploy proves are connected through USB.
resolve_connected_devices() {
  local json_path="$1"
  local devices
  devices=$(parse_active_devices_from_devicectl_json "$json_path")
  if [[ -n "$devices" ]]; then
    printf '%s\n' "$devices"
    return 0
  fi
  list_usb_devices_from_ios_deploy
}

print_no_connected_device_error() {
  echo "✗ No connected iOS device found."
  echo "  No active CoreDevice tunnel or USB connection is available."
  echo "  If a paired device is on Wi-Fi, allow local network access in any active"
  echo "  VPN, firewall, or packet filter, then retry."
  echo "  Or connect the device via USB."
}

# Build destination for xcodebuild from tunnel availability.
build_destination_for_device() {
  local tunnel_ok="$1"
  if [[ "$tunnel_ok" == "true" ]]; then
    echo "id=$DEVICE_ID"
  else
    echo "generic/platform=iOS"
  fi
}
