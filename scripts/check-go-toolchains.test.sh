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

# The stale version is derived from the pinned one, so a toolchain bump never
# turns these substitutions into no-ops.
CURRENT="$(awk '/^toolchain go/ {sub(/^toolchain go/, ""); print; exit}' "$REPO_ROOT/engine/go.mod")"
[[ "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "go-toolchain regression: cannot read the pinned toolchain from engine/go.mod" >&2
  exit 1
}
STALE="${CURRENT%.*}.$(( ${CURRENT##*.} + 1 ))"
CURRENT_RE="${CURRENT//./\\.}"

# Rewrites one pinned version in a fixture file and fails when nothing changed.
make_stale() {
  local label="$1" file="$2" expr="$3"
  sed -i.bak -E "$expr" "$file"
  if cmp -s "$file" "$file.bak"; then
    echo "go-toolchain regression: $label fixture was not changed" >&2
    exit 1
  fi
  rm -f "$file.bak"
}

cp "$REPO_ROOT/relay/go.mod" "$TMP_ROOT/relay/go.mod"
make_stale "stale relay module" "$TMP_ROOT/relay/go.mod" \
  "s/^toolchain go${CURRENT_RE}\$/toolchain go${STALE}/"
expect_failure "stale relay module"

cp "$REPO_ROOT/relay/go.mod" "$TMP_ROOT/relay/go.mod"
make_stale "stale relay Docker builder" "$TMP_ROOT/relay/Dockerfile" \
  "s/golang:${CURRENT_RE}-alpine/golang:${STALE}-alpine/"
expect_failure "stale relay Docker builder"

cp "$REPO_ROOT/relay/Dockerfile" "$TMP_ROOT/relay/Dockerfile"
make_stale "stale Linux parity image" "$TMP_ROOT/Makefile" \
  "s|^GO_VERSION := .*|GO_VERSION := ${STALE}|"
expect_failure "stale Linux parity image"

echo "go-toolchain regression checks: OK"
