#!/usr/bin/env bash
# Pins check-main-merge-node.sh on a scratch repository: a fast-forward of a
# branch and a commit straight on main are refused; a --no-ff merge, a push
# to another branch, a branch creation, and a no-op push pass.

set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-main-merge-node.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZERO="0000000000000000000000000000000000000000"

fail() { echo "FAIL: $*" >&2; exit 1; }

cd "$TMP"
git init -q -b main
git config user.email user@example.com
git config user.name "A User"
git commit -q --allow-empty -m "chore: root"
BASE="$(git rev-parse HEAD)"

git checkout -q -b feature
git commit -q --allow-empty -m "feat: one"
git commit -q --allow-empty -m "feat: two"
FEATURE="$(git rev-parse HEAD)"

# 1. Fast-forwarding main to the branch tip: refused.
if echo "refs/heads/main $FEATURE refs/heads/main $BASE" | bash "$SCRIPT" 2>/dev/null; then
  fail "a fast-forward of main was allowed"
fi

# 2. A single commit made straight on main: refused.
git checkout -q main
git commit -q --allow-empty -m "fix: straight on main"
DIRECT="$(git rev-parse HEAD)"
if echo "refs/heads/main $DIRECT refs/heads/main $BASE" | bash "$SCRIPT" 2>/dev/null; then
  fail "a direct commit on main was allowed"
fi
git reset -q --hard "$BASE"

# 3. A --no-ff merge of the branch: allowed.
git merge -q --no-ff -m "merge feature" feature
MERGE="$(git rev-parse HEAD)"
echo "refs/heads/main $MERGE refs/heads/main $BASE" | bash "$SCRIPT" || fail "a --no-ff merge was refused"

# 4. Pushing the feature branch itself (a fast-forward there): allowed.
echo "refs/heads/feature $FEATURE refs/heads/feature $BASE" | bash "$SCRIPT" || fail "a non-main push was judged"

# 5. Creating main on the remote, and a push with nothing to update: allowed.
echo "refs/heads/main $FEATURE refs/heads/main $ZERO" | bash "$SCRIPT" || fail "creating main was refused"
echo "refs/heads/main $MERGE refs/heads/main $MERGE" | bash "$SCRIPT" || fail "a no-op push was refused"

# 6. Several lines: one bad line fails the whole push.
if printf '%s\n%s\n' "refs/heads/feature $FEATURE refs/heads/feature $BASE" "refs/heads/main $FEATURE refs/heads/main $BASE" | bash "$SCRIPT" 2>/dev/null; then
  fail "a bad main line among good lines was allowed"
fi

echo "check-main-merge-node: 6 cases passed"
