#!/usr/bin/env bash
# Regression tests for targeted CoreSimulator launch retry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ios-test-retry.sh
source "$SCRIPT_DIR/ios-test-retry.sh"

TMP_DIR="$(mktemp -d -t ios-test-retry.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
LOG_FILE="$TMP_DIR/xcodebuild.log"
CALLS_FILE="$TMP_DIR/simctl-calls"

xcrun() {
  printf '%s\n' "$*" >> "$CALLS_FILE"
  return 0
}

printf '%s\n' 'Assertion failed: expected true' > "$LOG_FILE"
if ios_test_prepare_launch_retry "$LOG_FILE" "SIMULATOR-UDID"; then
  echo "non-launch failure incorrectly retried" >&2
  exit 1
fi
if [[ -e "$CALLS_FILE" ]]; then
  echo "non-launch failure reset simulator" >&2
  exit 1
fi

printf '%s\n' 'Simulator device failed to launch com.example.app.' > "$LOG_FILE"
ios_test_prepare_launch_retry "$LOG_FILE" "SIMULATOR-UDID"
EXPECTED_CALLS=$'simctl shutdown SIMULATOR-UDID\nsimctl boot SIMULATOR-UDID\nsimctl bootstatus SIMULATOR-UDID -b'
if [[ "$(cat "$CALLS_FILE")" != "$EXPECTED_CALLS" ]]; then
  echo "launch retry did not reset and await simulator" >&2
  exit 1
fi

: > "$CALLS_FILE"
ios_test_prepare_launch_retry "$LOG_FILE" ""
if [[ -s "$CALLS_FILE" ]]; then
  echo "explicit destination unexpectedly reset simulator" >&2
  exit 1
fi

echo "ios-test retry checks: OK"
