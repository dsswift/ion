#!/usr/bin/env bash
# Shell helpers for concise xcodebuild output with actionable failure diagnostics.

print_xcodebuild_failure() {
  local log_file="$1"
  local diagnostics

  diagnostics=$(grep -E '(^|[[:space:]])(fatal )?error:' "$log_file" || true)
  if [[ -n "$diagnostics" ]]; then
    printf '%s\n' 'Compiler diagnostics:'
    printf '%s\n' "$diagnostics"
    return
  fi

  printf '%s\n' 'No compiler diagnostic found. Last build output:'
  tail -20 "$log_file"
}
