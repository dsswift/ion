#!/usr/bin/env bash
# Regression tests for concise xcodebuild failure diagnostics.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=ios/commands/xcodebuild-output.sh
source "$SCRIPT_DIR/xcodebuild-output.sh"

bash -n "$SCRIPT_DIR/install.command"

TMP_DIR="$(mktemp -d -t xcodebuild-output.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

COMPILER_LOG="$TMP_DIR/compiler.log"
cat > "$COMPILER_LOG" <<'LOG'
CompileSwift normal arm64
/fixture/ConversationView+Grouping.swift:58:18: error: tuple pattern has the wrong length for tuple type '(Message, followsUser: Bool)'
/fixture/GroupedItemContentHashTests.swift:35:49: error: missing argument for parameter 'followsUser' in call
LOG

compiler_output=$(print_xcodebuild_failure "$COMPILER_LOG")
expected_compiler_output=$'Compiler diagnostics:\n/fixture/ConversationView+Grouping.swift:58:18: error: tuple pattern has the wrong length for tuple type \'(Message, followsUser: Bool)\'\n/fixture/GroupedItemContentHashTests.swift:35:49: error: missing argument for parameter \'followsUser\' in call'
if [[ "$compiler_output" != "$expected_compiler_output" ]]; then
  echo "compiler diagnostics were not preserved" >&2
  exit 1
fi

OTHER_LOG="$TMP_DIR/other.log"
printf '%s\n' 'xcodebuild: error: unable to find a destination matching the provided destination specifier:' > "$OTHER_LOG"
other_output=$(print_xcodebuild_failure "$OTHER_LOG")
if [[ "$other_output" != $'Compiler diagnostics:\nxcodebuild: error: unable to find a destination matching the provided destination specifier:' ]]; then
  echo "generic xcodebuild error was not preserved" >&2
  exit 1
fi

EMPTY_LOG="$TMP_DIR/empty.log"
printf '%s\n' 'Build system information' 'Build failed without compiler output' > "$EMPTY_LOG"
fallback_output=$(print_xcodebuild_failure "$EMPTY_LOG")
if [[ "$fallback_output" != $'No compiler diagnostic found. Last build output:\nBuild system information\nBuild failed without compiler output' ]]; then
  echo "fallback build output was not preserved" >&2
  exit 1
fi

echo "xcodebuild output checks: OK"
