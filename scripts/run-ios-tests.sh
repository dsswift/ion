#!/usr/bin/env bash
# Run the IonRemote unit-test target on the latest available iPhone Simulator.
#
# Used by `make ios-test`. Picks the highest-iOS-version "iPhone *" simulator
# that's actually installed on this machine so the Makefile target doesn't
# rot when Xcode updates its default device names. Override with:
#   IOS_TEST_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5'
# in the environment.
#
# Exits non-zero on test failure or if no usable simulator is found.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../ios" && pwd)"
cd "$PROJECT_DIR"

# Pick a destination unless one was explicitly provided.
if [[ -z "${IOS_TEST_DESTINATION:-}" ]]; then
  # Parse `xcrun simctl list devices available` and pick the newest iPhone
  # entry. The list is grouped by runtime in version order, so the last
  # match wins. Format example:
  #   -- iOS 26.5 --
  #       iPhone 17 (UDID) (Shutdown)
  # macOS ships BSD awk, which doesn't honor `\s` — use `[[:space:]]` instead.
  DEVICE_LINE="$(
    xcrun simctl list devices available \
      | awk '/^-- iOS / { rt=$0 } /^[[:space:]]+iPhone/ { print rt "|" $0 }' \
      | tail -1
  )"
  if [[ -z "$DEVICE_LINE" ]]; then
    echo "❌ No available iPhone simulator found (xcrun simctl list devices)." >&2
    echo "   Install one via Xcode → Settings → Components." >&2
    exit 1
  fi
  # DEVICE_LINE looks like "-- iOS 26.5 --|    iPhone 17 (UDID) (Shutdown)".
  # Extract the runtime version and the device name (everything between the
  # leading whitespace and the " (UDID) (State)" trailer).
  DEVICE_RUNTIME="$(echo "$DEVICE_LINE" | sed -E 's/^-- iOS ([0-9.]+) --\|.*/\1/')"
  DEVICE_NAME="$(echo "$DEVICE_LINE" | sed -E 's/^.*\|[[:space:]]+(.+) \([0-9A-Fa-f-]+\) \([^)]+\)[[:space:]]*$/\1/')"
  if [[ -z "$DEVICE_RUNTIME" || -z "$DEVICE_NAME" || "$DEVICE_LINE" == "$DEVICE_NAME" ]]; then
    echo "❌ Could not parse simulator info from line:" >&2
    echo "   $DEVICE_LINE" >&2
    exit 1
  fi
  IOS_TEST_DESTINATION="platform=iOS Simulator,name=${DEVICE_NAME},OS=${DEVICE_RUNTIME}"
  echo "→ ios-test using: ${IOS_TEST_DESTINATION}"
fi

# Run the test bundle. We want both readable output (per-test status,
# totals, errors) AND a faithful exit code. Approach: log everything to a
# temp file, grep the interesting lines to stdout, then exit with
# xcodebuild's real status.
LOG_FILE="$(mktemp -t ios-test.XXXXXX.log)"
trap 'rm -f "$LOG_FILE"' EXIT

set +e
xcodebuild \
  -project IonRemote.xcodeproj \
  -scheme IonRemote \
  -destination "$IOS_TEST_DESTINATION" \
  test \
  > "$LOG_FILE" 2>&1
STATUS=$?
set -e

# Surface per-test results, error lines, and the final status banner.
grep -E "^Test Suite |^Test case |error:|\*\* TEST|^[[:space:]]*Executed " "$LOG_FILE" || true

if [[ $STATUS -ne 0 ]]; then
  echo "" >&2
  echo "❌ ios-test FAILED (xcodebuild exit=$STATUS). Full log:" >&2
  echo "   $LOG_FILE" >&2
  # Keep the log on failure so it can be inspected; the EXIT trap removes
  # it on success.
  trap - EXIT
  exit "$STATUS"
fi
