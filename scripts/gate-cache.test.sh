#!/usr/bin/env bash
# Regression coverage for scripts/gate-cache.sh.
#
# Pins the two properties the receipt has to get right. It must skip a gate
# only when re-running it could not produce a different answer, and it must
# re-run whenever any input to that answer moved: the commit, the working
# tree, the platform, the gate's Dockerfile, or the gate command in the
# Makefile. A receipt that is honoured too eagerly silently green-lights an
# untested commit, which is worse than no cache at all.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/gate-cache.sh"
TMP_ROOT="$(mktemp -d -t gate-cache-test.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/scripts/docker"
cd "$TMP_ROOT"
git init -q .
git config user.email "test@example.com"
git config user.name "Gate Cache Test"

printf 'FROM node:22\n' > scripts/docker/test-linux-desktop.Dockerfile
printf 'test-linux-desktop:\n\t@true\n' > Makefile
git add -A
git commit -q -m "seed"

check() { ION_GATE_CACHE_ROOT="$TMP_ROOT" bash "$SCRIPT" check desktop "$1" >/dev/null 2>&1; }
save()  { ION_GATE_CACHE_ROOT="$TMP_ROOT" bash "$SCRIPT" save  desktop "$1" >/dev/null 2>&1; }

fail() { echo "gate-cache regression: $1" >&2; exit 1; }
expect_miss() { check "${2:-linux/arm64}" && fail "$1 unexpectedly hit the cache"; return 0; }
expect_hit()  { check "${2:-linux/arm64}" || fail "$1 unexpectedly missed the cache"; return 0; }

expect_miss "a fresh repo with no receipt"

save linux/arm64
expect_hit "an unchanged clean tree after a recorded pass"

# A dirty tree means the bind-mounted /src differs from what was recorded.
printf 'dirty\n' > stray.txt
expect_miss "a dirty worktree"
rm -f stray.txt
expect_hit "the tree returning to clean"

# Switching arch must not inherit the other arch's pass.
expect_miss "a different platform" linux/amd64

# Any change to the gate's own definition invalidates the receipt.
printf 'FROM node:22\nRUN echo changed\n' > scripts/docker/test-linux-desktop.Dockerfile
git add -A && git commit -q -m "change dockerfile"
expect_miss "a changed Dockerfile"
save linux/arm64
expect_hit "a recorded pass on the new Dockerfile"

printf 'test-linux-desktop:\n\t@echo changed\n' > Makefile
git add -A && git commit -q -m "change makefile"
expect_miss "a changed gate command in the Makefile"
save linux/arm64
expect_hit "a recorded pass on the new Makefile"

# A new commit is new bytes, even with the gate definition untouched.
printf 'unrelated\n' > other.txt
git add -A && git commit -q -m "new commit"
expect_miss "a new commit"

# The force escape hatch always runs the gate.
save linux/arm64
expect_hit "a recorded pass before testing the force flag"
ION_GATE_CACHE_ROOT="$TMP_ROOT" ION_GATE_FORCE=1 bash "$SCRIPT" check desktop linux/arm64 >/dev/null 2>&1 \
  && fail "ION_GATE_FORCE=1 did not force a run"

# Saving from a dirty tree must not record anything.
RECEIPT="$TMP_ROOT/.git/ion-test-linux-desktop-success"
rm -f "$RECEIPT"
printf 'dirty\n' > stray.txt
save linux/arm64
[ -f "$RECEIPT" ] && fail "a dirty tree recorded a receipt"
rm -f stray.txt

echo "✅ gate-cache: all receipt semantics pinned"
