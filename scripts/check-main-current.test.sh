#!/usr/bin/env bash
# Pins check-main-current.sh against a scratch repository with a bare remote,
# including the race it exists for: the pipeline's version commit landing on
# the remote after a push was built.

set -euo pipefail

CURRENT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-main-current.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
export GIT_CONFIG_NOSYSTEM=1 HOME="$TMP/home"
mkdir -p "$HOME"
git config --global init.defaultBranch main
git config --global user.email user@example.com
git config --global user.name "A User"

# remote.git is GitHub; work/ is the operator; robot/ is the pipeline.
git init -q --bare "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/work" 2>/dev/null
cd "$TMP/work"
echo base > base.txt && git add base.txt && git commit -qm "chore: base" && git push -q origin main
echo one > one.txt && git add one.txt && git commit -qm "feat: one"
git clone -q "$TMP/remote.git" "$TMP/robot" 2>/dev/null
OLD="$(git rev-parse origin/main)"
(cd "$TMP/robot" && echo 1.0.1 > VERSION && git add VERSION && git commit -qm "chore: release versions [skip ci]" && git push -q origin main)
NOW="$(git --git-dir="$TMP/remote.git" rev-parse main)"
TIP="$(git rev-parse HEAD)"

# 1. A push built on an old main is refused in a second.
if echo "refs/heads/main $TIP refs/heads/main $OLD" | bash "$CURRENT" origin 2>/dev/null; then
  fail "a push built on an old main was allowed"
fi

# 2. A push built on the current main passes.
echo "refs/heads/main $TIP refs/heads/main $NOW" | bash "$CURRENT" origin || fail "a current push was refused"

# 3. A push to another branch is not judged.
echo "refs/heads/feature $TIP refs/heads/feature $OLD" | bash "$CURRENT" origin || fail "a non-main push was judged"

echo "check-main-current: 3 cases passed"
