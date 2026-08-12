#!/usr/bin/env bash
# Pre-push gate. Runs the subset of CI checks that are (a) likely to fail
# from local edits and (b) fast enough to wait on. Anything network- or
# build-heavy (engine race tests, govulncheck, docker, xcodebuild) stays in
# CI — running it locally on every push would dominate flow time.
#
# Bypass: `git push --no-verify` (use sparingly).
#
# Husky is the single hook system for this repo: root `package.json` has
# `"prepare": "husky"`, so `npm install` points core.hooksPath at `.husky/_`
# on every clone with no manual step.
#
# Why this body lives in scripts/ instead of directly in .husky/pre-push:
# husky's generated wrapper invokes the hook with `sh -e "$hook"` (see
# .husky/_/h), which means the hook file's shebang is never consulted. On
# Linux /bin/sh is dash, which rejects both `set -o pipefail` and bash array
# syntax (`failures=()`) — the hook would exit 2 before running a single
# gate, and every push from a Linux clone would be blocked with zero checks
# performed. macOS masks this entirely because /bin/sh is bash there. So
# .husky/pre-push is a one-line dash-safe delegator that execs bash on this
# file, and the bash-dependent gate logic lives here where the interpreter
# is guaranteed.

set -uo pipefail

# Guard both the rev-parse and the cd: `set -e` is deliberately absent (a
# failing gate must be recorded, not abort the script), so an unguarded cd
# would silently continue and resolve every relative path below against the
# wrong directory. Matches scripts/graphify-rebuild.sh.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
cd "$REPO_ROOT" || exit 1

# Resolve the merge-base against origin/main so we only run checks for the
# components actually touched on this branch.
BASE_REF="origin/main"
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "pre-push: $BASE_REF not found locally; skipping change-scoped checks"
  CHANGED=""
  BASE_SHA="missing"
else
  BASE_SHA="$(git rev-parse "$BASE_REF")"
  CHANGED="$(git diff --name-only "$(git merge-base HEAD "$BASE_REF")"...HEAD 2>/dev/null || true)"
fi

# A successful validation belongs to one exact branch tip, base ref, and gate
# implementation. Long full-suite runs can outlive a caller's process timeout
# after every gate has passed; without this receipt, retrying the push reruns the
# same expensive checks forever and may never reach transport. Keep the receipt
# in git metadata, never the worktree, and use it only when the worktree is clean.
# Any commit, base update, gate edit, or dirty file invalidates the match.
CACHE_PATH="$(git rev-parse --git-path ion-pre-push-success)"
CACHE_KEY="$(git rev-parse HEAD):${BASE_SHA}:$(git hash-object scripts/pre-push.sh)"
WORKTREE_CLEAN=false
if [ -z "$(git status --porcelain)" ]; then
  WORKTREE_CLEAN=true
fi
if [ "$WORKTREE_CLEAN" = true ] && [ -f "$CACHE_PATH" ] && [ "$(cat "$CACHE_PATH")" = "$CACHE_KEY" ]; then
  echo "pre-push: exact HEAD already passed all gates"
  exit 0
fi

touched() {
  # touched <pattern> -> 0 if any changed file matches, 1 otherwise
  local pattern="$1"
  [ -z "$CHANGED" ] && return 0  # unknown scope -> assume touched (safer)
  echo "$CHANGED" | grep -qE "$pattern"
}

failures=()
run() {
  local label="$1"; shift
  echo
  echo "▶ $label"
  if "$@"; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label"
    failures+=("$label")
  fi
}

# File-size cap. Cheap, runs always — most file-size violations come from
# files outside the changed set (e.g. an editor accidentally rewriting a
# whole file's whitespace).
run "file-size cap" bash scripts/check-file-sizes.sh

# Dashboards-as-code drift + overcount audit. Runs when the query module,
# recipes, or the committed dashboard JSONs are touched. Cheap (Node native
# type-stripping, zero install) and catches hand-edited JSON or un-regenerated
# module changes before CI. See ADR-020.
if touched "^docs/observability/(dashboards/|grafana/provisioning/dashboards/|queries\.md)"; then
  run "dashboards drift + overcount audit" make check-dashboards
fi

# Engine: lint diff vs main. Mirrors CI's --new-from-merge-base flag.
if touched "^engine/"; then
  run "engine lint (new vs origin/main)" bash -c \
    "cd engine && golangci-lint run --new-from-merge-base=origin/main"
  run "engine build" bash -c "cd engine && go build ./..."
  # Windows is the one release target the host build cannot approximate: the
  # setsockopt descriptor type differs there (int vs syscall.Handle), so a
  # platform-specific compile error passes a native build and only surfaces in
  # the release workflow after merge. CI's engine-crossbuild job covers all
  # four release targets; this covers the one that actually broke, cheaply.
  run "engine cross-build (windows)" bash -c \
    "cd engine && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./..."
fi

# Relay: same.
if touched "^relay/"; then
  run "relay lint (new vs origin/main)" bash -c \
    "cd relay && golangci-lint run --new-from-merge-base=origin/main"
fi

# Desktop: typecheck + unit tests. Both fast.
if touched "^desktop/"; then
  run "desktop typecheck" bash -c "cd desktop && npm run typecheck"
  run "desktop tests"     bash -c "cd desktop && npm test --silent"
  run "desktop build"     bash -c "cd desktop && npm run build"
fi

# iOS: match the required PR compile + targeted contract/parity gate. The full
# simulator suite runs on the nightly/manual CI lane, not every branch push.
if touched "^ios/|^scripts/run-ios-tests\.sh$|^Makefile$|^\.github/workflows/quality\.yml$"; then
  run "iOS PR contracts and parity" make ios-pr-check
fi

# Workflow YAML changes: actionlint mirrors CI.
if touched "^\.github/workflows/"; then
  if command -v actionlint >/dev/null 2>&1; then
    run "actionlint" actionlint
  else
    echo
    echo "▶ actionlint (skipped — install with: brew install actionlint)"
  fi
fi

if [ ${#failures[@]} -gt 0 ]; then
  echo
  echo "pre-push BLOCKED. Failed gates:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  echo
  echo "Fix locally and re-push, or bypass with: git push --no-verify"
  exit 1
fi

echo
if [ "$WORKTREE_CLEAN" = true ]; then
  printf '%s\n' "$CACHE_KEY" > "$CACHE_PATH"
fi
echo "pre-push: all gates passed"
