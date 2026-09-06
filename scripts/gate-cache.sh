#!/usr/bin/env bash
# Result receipt for the Linux parity gates (`make test-linux-engine`,
# `make test-linux-desktop`).
#
# The gates already cache their *inputs*: prebaked images plus named volumes
# holding the Go module cache, the Go build cache, and the npm download cache.
# Nothing cached the *result*, so running a gate twice on an unchanged commit
# paid the full multi-minute container run again to re-derive an answer that
# could not have changed.
#
# This mirrors the receipt scripts/pre-push.sh keeps for its own gate set. The
# key binds the recorded pass to everything that could change it, and a match
# is honoured only when the worktree is clean: the gates bind-mount the working
# tree at /src rather than checking out HEAD, so a dirty tree means the receipt
# describes different bytes than a run would actually see. In that case there
# is no skip and no save.
#
# The receipt lives in git metadata (`git rev-parse --git-path`), never in the
# worktree, so it can never dirty `git status`. In a linked worktree that path
# resolves under .git/worktrees/<name>/, which makes the receipt per-worktree
# without any extra keying.
#
# usage:
#   gate-cache.sh check <gate> <platform>   exit 0 = hit, skip the gate
#                                           exit 1 = miss, run the gate
#   gate-cache.sh save  <gate> <platform>   record a pass
#
# Set ION_GATE_FORCE=1 to ignore an existing receipt and force a full run.

set -euo pipefail

MODE="${1:?usage: gate-cache.sh check|save <gate> <platform>}"
GATE="${2:?usage: gate-cache.sh check|save <gate> <platform>}"
PLATFORM="${3:?usage: gate-cache.sh check|save <gate> <platform>}"

# ION_GATE_CACHE_ROOT exists so the regression test can drive this script
# against a scratch repository instead of the developer's real checkout.
ROOT="${ION_GATE_CACHE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

DOCKERFILE="scripts/docker/test-linux-${GATE}.Dockerfile"

# Every input that can change the gate's answer, in one line:
#   HEAD        the commit under test
#   PLATFORM    switching arch re-runs rather than trusting the other arch's pass
#   Dockerfile  the image the gate builds
#   Makefile    the gate command itself lives here
# git hash-object hashes file content directly, so this works whether or not
# the file is tracked or staged.
cache_key() {
  printf '%s:%s:%s:%s\n' \
    "$(git rev-parse HEAD 2>/dev/null || echo no-head)" \
    "$PLATFORM" \
    "$(git hash-object "$DOCKERFILE" 2>/dev/null || echo no-dockerfile)" \
    "$(git hash-object Makefile 2>/dev/null || echo no-makefile)"
}

receipt_path() {
  git rev-parse --git-path "ion-test-linux-${GATE}-success"
}

worktree_clean() {
  [ -z "$(git status --porcelain 2>/dev/null)" ]
}

case "$MODE" in
  check)
    if [ -n "${ION_GATE_FORCE:-}" ]; then
      echo "▶ ${GATE}: ION_GATE_FORCE set, ignoring any receipt and running the gate"
      exit 1
    fi
    if ! worktree_clean; then
      echo "▶ ${GATE}: worktree dirty, running the gate (a receipt would not describe these bytes)"
      exit 1
    fi
    RECEIPT="$(receipt_path)"
    if [ -f "$RECEIPT" ] && [ "$(cat "$RECEIPT")" = "$(cache_key)" ]; then
      echo "✅ ${GATE}: this exact HEAD already passed on ${PLATFORM}, skipping (ION_GATE_FORCE=1 to rerun)"
      exit 0
    fi
    if [ -f "$RECEIPT" ]; then
      echo "▶ ${GATE}: receipt exists but does not match this HEAD/platform/gate definition, running the gate"
    else
      echo "▶ ${GATE}: no receipt recorded yet, running the gate"
    fi
    exit 1
    ;;
  save)
    if worktree_clean; then
      cache_key > "$(receipt_path)"
      echo "✅ ${GATE}: recorded pass for $(git rev-parse --short HEAD 2>/dev/null || echo '(no HEAD)') on ${PLATFORM}"
    else
      echo "⚠️  ${GATE}: worktree dirty, not recording a receipt"
    fi
    ;;
  *)
    echo "gate-cache: unknown mode '${MODE}' (expected 'check' or 'save')" >&2
    exit 2
    ;;
esac
