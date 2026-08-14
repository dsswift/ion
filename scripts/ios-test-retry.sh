#!/usr/bin/env bash
# Helpers for one targeted retry when CoreSimulator refuses to launch XCTest.


ios_test_is_launch_failure() {
  local log_file="$1"
  grep -Eq \
    'Simulator device failed to launch|FBSOpenApplicationServiceErrorDomain Code=1|FBProcessExit Code=64 "The process failed to launch"' \
    "$log_file"
}

ios_test_prepare_launch_retry() {
  local log_file="$1"
  local simulator_udid="$2"

  ios_test_is_launch_failure "$log_file" || return 1

  echo "⚠️  CoreSimulator denied XCTest launch; retrying once." >&2
  if [[ -z "$simulator_udid" ]]; then
    echo "   Destination was explicit; retrying without simulator reset." >&2
    return 0
  fi

  echo "   Resetting simulator ${simulator_udid}." >&2
  if ! xcrun simctl shutdown "$simulator_udid"; then
    echo "⚠️  Simulator shutdown failed before retry; attempting boot anyway." >&2
  fi
  if ! xcrun simctl boot "$simulator_udid"; then
    echo "❌ Simulator boot failed; cannot retry XCTest." >&2
    return 1
  fi
  if ! xcrun simctl bootstatus "$simulator_udid" -b; then
    echo "❌ Simulator did not become ready; cannot retry XCTest." >&2
    return 1
  fi
}
