#!/usr/bin/env bash
# Run the IonRemote unit-test target on the latest available iPhone Simulator.
#
# Used by `make ios-test`. Picks the highest-iOS-version "iPhone *" simulator
# that's actually installed on this machine so the Makefile target doesn't
# rot when Xcode updates its default device names. Override with:
#   IOS_TEST_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5'
# or pass signing build settings used by CI through IOS_TEST_BUILD_SETTINGS:
#   IOS_TEST_BUILD_SETTINGS='CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=-'
# or select XCTest classes through IOS_TEST_ONLY:
#   IOS_TEST_ONLY='IonRemoteTests/ContractSyncTests IonRemoteTests/ThemeParityTests'
# in the environment.
#
# Exits non-zero on test failure or if no usable simulator is found. A simulator
# process launch denial gets one reset-and-retry because XCTest has not started.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../ios" && pwd)"
# shellcheck source=scripts/ios-test-retry.sh
source "$(dirname "$0")/ios-test-retry.sh"
cd "$PROJECT_DIR"

SIMULATOR_UDID=""

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
  DEVICE_NAME="$(echo "$DEVICE_LINE" | sed -E 's/^.*\|[[:space:]]+(.+) \(([0-9A-Fa-f-]+)\) \([^)]+\)[[:space:]]*$/\1/')"
  SIMULATOR_UDID="$(echo "$DEVICE_LINE" | sed -E 's/^.*\|[[:space:]]+.+ \(([0-9A-Fa-f-]+)\) \([^)]+\)[[:space:]]*$/\1/')"
  if [[ -z "$DEVICE_RUNTIME" || -z "$DEVICE_NAME" || -z "$SIMULATOR_UDID" || "$DEVICE_LINE" == "$DEVICE_NAME" || "$DEVICE_LINE" == "$SIMULATOR_UDID" ]]; then
    echo "❌ Could not parse simulator info from line:" >&2
    echo "   $DEVICE_LINE" >&2
    exit 1
  fi
  IOS_TEST_DESTINATION="platform=iOS Simulator,name=${DEVICE_NAME},OS=${DEVICE_RUNTIME}"
  echo "→ ios-test using: ${IOS_TEST_DESTINATION}"
fi

# Build xcodebuild arguments with positional parameters, rather than expanding an
# empty array. macOS Bash 3 treats an empty array as unset under `set -u`, which
# made the nightly full-suite path fail before Xcode when IOS_TEST_ONLY was not
# provided.
set -- \
  xcodebuild \
  -project IonRemote.xcodeproj \
  -scheme IonRemote \
  -destination "$IOS_TEST_DESTINATION"

if [[ -n "${IOS_TEST_BUILD_SETTINGS:-}" ]]; then
  # shellcheck disable=SC2206
  BUILD_SETTINGS=(${IOS_TEST_BUILD_SETTINGS})
  set -- "$@" "${BUILD_SETTINGS[@]}"
fi

if [[ -n "${IOS_TEST_ONLY:-}" ]]; then
  # shellcheck disable=SC2206
  TEST_SELECTORS=(${IOS_TEST_ONLY})
  for selector in "${TEST_SELECTORS[@]}"; do
    set -- "$@" "-only-testing:${selector}"
  done
fi

LOG_FILE="$(mktemp -t ios-test.XXXXXX.log)"
trap 'rm -f "$LOG_FILE"' EXIT

run_ios_test() {
  set +e
  "$@" test > "$LOG_FILE" 2>&1
  local status=$?
  set -e
  return "$status"
}

STATUS=0
run_ios_test "$@" || STATUS=$?
if [[ $STATUS -ne 0 ]] && ios_test_prepare_launch_retry "$LOG_FILE" "$SIMULATOR_UDID"; then
  : > "$LOG_FILE"
  STATUS=0
  run_ios_test "$@" || STATUS=$?
fi

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
