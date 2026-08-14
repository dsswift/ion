#!/usr/bin/env bash
# Enforce one Go toolchain patch across executable modules and build images.

set -euo pipefail

ROOT="${ION_TOOLCHAIN_CHECK_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

fail() {
  echo "go-toolchain check: $*" >&2
  exit 1
}

module_toolchain() {
  local file="$1"
  local version
  version="$(awk '/^toolchain go/ {sub(/^toolchain go/, ""); print; exit}' "$file")"
  [[ -n "$version" ]] || fail "$file has no toolchain directive"
  printf '%s\n' "$version"
}

docker_toolchain() {
  local file="$1"
  local version
  version="$(sed -nE 's/^FROM golang:([0-9]+\.[0-9]+\.[0-9]+)(-alpine)?([[:space:]]+AS[[:space:]].*)?$/\1/p' "$file" | head -1)"
  [[ -n "$version" ]] || fail "$file must pin an exact golang patch image"
  printf '%s\n' "$version"
}

ENGINE_VERSION="$(module_toolchain "$ROOT/engine/go.mod")"
RELAY_VERSION="$(module_toolchain "$ROOT/relay/go.mod")"
ENGINE_DOCKER_VERSION="$(docker_toolchain "$ROOT/engine/Dockerfile")"
RELAY_DOCKER_VERSION="$(docker_toolchain "$ROOT/relay/Dockerfile")"
MAKE_VERSION="$({
  printf '%s\n' 'include Makefile' '.PHONY: print-go-version' 'print-go-version:'
  # shellcheck disable=SC2016 # Make expands GO_VERSION in generated recipe.
  printf '\t@printf '\''%%s\\n'\'' '\''$(GO_VERSION)'\''\n'
} | make -s --no-print-directory -C "$ROOT" -f - print-go-version)"

[[ "$RELAY_VERSION" == "$ENGINE_VERSION" ]] || \
  fail "relay toolchain $RELAY_VERSION differs from engine $ENGINE_VERSION"
[[ "$ENGINE_DOCKER_VERSION" == "$ENGINE_VERSION" ]] || \
  fail "engine Docker builder $ENGINE_DOCKER_VERSION differs from module $ENGINE_VERSION"
[[ "$RELAY_DOCKER_VERSION" == "$RELAY_VERSION" ]] || \
  fail "relay Docker builder $RELAY_DOCKER_VERSION differs from module $RELAY_VERSION"
[[ "$MAKE_VERSION" == "$ENGINE_VERSION" ]] || \
  fail "Linux parity image $MAKE_VERSION differs from engine toolchain $ENGINE_VERSION"

echo "go-toolchain check: OK ($ENGINE_VERSION)"
