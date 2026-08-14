#!/usr/bin/env bash
# Regression coverage for scripts/check-go-toolchains.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-go-toolchains.sh"
TMP_ROOT="$(mktemp -d -t go-toolchain-check.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/engine" "$TMP_ROOT/relay"
cp "$REPO_ROOT/Makefile" "$TMP_ROOT/Makefile"
cp "$REPO_ROOT/engine/go.mod" "$TMP_ROOT/engine/go.mod"
cp "$REPO_ROOT/engine/Dockerfile" "$TMP_ROOT/engine/Dockerfile"
cp "$REPO_ROOT/relay/go.mod" "$TMP_ROOT/relay/go.mod"
cp "$REPO_ROOT/relay/Dockerfile" "$TMP_ROOT/relay/Dockerfile"

run_check() {
  ION_TOOLCHAIN_CHECK_ROOT="$TMP_ROOT" bash "$CHECK" >/dev/null 2>&1
}

expect_failure() {
  local label="$1"
  if run_check; then
    echo "go-toolchain regression: $label unexpectedly passed" >&2
    exit 1
  fi
}

run_check

cp "$REPO_ROOT/relay/go.mod" "$TMP_ROOT/relay/go.mod"
sed -i.bak 's/toolchain go1\.26\.6/toolchain go1.26.5/' "$TMP_ROOT/relay/go.mod"
rm -f "$TMP_ROOT/relay/go.mod.bak"
expect_failure "stale relay module"

cp "$REPO_ROOT/relay/go.mod" "$TMP_ROOT/relay/go.mod"
sed -i.bak 's/golang:1\.26\.6-alpine/golang:1.26.5-alpine/' "$TMP_ROOT/relay/Dockerfile"
rm -f "$TMP_ROOT/relay/Dockerfile.bak"
expect_failure "stale relay Docker builder"

cp "$REPO_ROOT/relay/Dockerfile" "$TMP_ROOT/relay/Dockerfile"
sed -i.bak "s|GO_VERSION := .*|GO_VERSION := 1.25.0|" "$TMP_ROOT/Makefile"
rm -f "$TMP_ROOT/Makefile.bak"
expect_failure "stale Linux parity image"

echo "go-toolchain regression checks: OK"
