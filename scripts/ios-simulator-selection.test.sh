#!/usr/bin/env bash
# Regression tests for stale CoreSimulator records.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/ios-simulator-selection.sh"

TMP_DIR="$(mktemp -d -t ios-simulator-selection.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/devices.json" <<JSON
{
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      {
        "name": "iPhone 17",
        "udid": "STALE-NEWEST",
        "isAvailable": true,
        "dataPath": "$TMP_DIR/missing"
      }
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      {
        "name": "iPhone 17",
        "udid": "VALID-OLDER",
        "isAvailable": true,
        "dataPath": "$TMP_DIR/valid"
      }
    ]
  }
}
JSON
mkdir "$TMP_DIR/valid"

cat > "$TMP_DIR/xcrun" <<'SCRIPT'
#!/usr/bin/env bash
cat "$IOS_SIMULATOR_SELECTION_FIXTURE"
SCRIPT
chmod +x "$TMP_DIR/xcrun"

IOS_SIMULATOR_SELECTION_FIXTURE="$TMP_DIR/devices.json" \
  PATH="$TMP_DIR:$PATH" \
  expected='26.4|iPhone 17|VALID-OLDER' \
  actual="$(IOS_SIMULATOR_SELECTION_FIXTURE="$TMP_DIR/devices.json" PATH="$TMP_DIR:$PATH" select_ios_simulator)"
if [[ "$actual" != "$expected" ]]; then
  echo "stale simulator selection was not skipped: $actual" >&2
  exit 1
fi

echo "ios simulator selection checks: OK"
