#!/usr/bin/env bash
# Pins land.sh and check-main-current.sh against a scratch repository with a
# bare remote, including the race they exist for: the pipeline's version
# commit landing on the remote while a push is in flight.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND="$HERE/land.sh"
CURRENT="$HERE/check-main-current.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
gitq() { git -c user.email=user@example.com -c user.name="A User" "$@"; }
export GIT_CONFIG_NOSYSTEM=1 HOME="$TMP/home"
mkdir -p "$HOME"
git config --global init.defaultBranch main
git config --global user.email user@example.com
git config --global user.name "A User"
git config --global pull.rebase true

# remote.git is GitHub; work/ is the operator; robot/ is the pipeline.
fresh() {
  rm -rf "$TMP/remote.git" "$TMP/work" "$TMP/robot"
  git init -q --bare "$TMP/remote.git"
  git clone -q "$TMP/remote.git" "$TMP/work" 2>/dev/null
  cd "$TMP/work"
  echo base > base.txt && git add base.txt && gitq commit -qm "chore: base" && git push -q origin main
  git checkout -q -b feature
  echo one > one.txt && git add one.txt && gitq commit -qm "feat: one"
  echo two > two.txt && git add two.txt && gitq commit -qm "feat: two"
  git clone -q "$TMP/remote.git" "$TMP/robot" 2>/dev/null
}
robot_bump() {
  (cd "$TMP/robot" && git pull -q && echo "$1" > VERSION && git add VERSION && gitq commit -qm "chore: release versions [skip ci]" && git push -q origin main)
}
remote_main() { git --git-dir="$TMP/remote.git" rev-parse main; }
parents() { git --git-dir="$TMP/remote.git" rev-list --parents -n 1 "$1" | wc -w | tr -d ' '; }

# 1. A clean landing: the remote's main is a merge node of main and the branch,
#    and the operator is back on the branch they started from.
fresh
bash "$LAND" feature >/dev/null 2>&1 || fail "clean land failed"
[ "$(parents "$(remote_main)")" -eq 3 ] || fail "remote main tip is not a merge"
git --git-dir="$TMP/remote.git" merge-base --is-ancestor "$(git rev-parse feature)" main || fail "branch not in main"
[ "$(git branch --show-current)" = feature ] || fail "did not return to the starting branch"

# 2. The race: the robot pushes its version commit while the push is in flight.
#    The first push is refused by the remote; land merges again on top of the
#    robot's commit and the robot's commit survives.
fresh
mkdir -p .git/hooks
cat > .git/hooks/pre-push <<EOF
#!/usr/bin/env bash
cat >/dev/null
if [ ! -f "$TMP/raced" ]; then
  touch "$TMP/raced"
  cd "$TMP/robot" && git pull -q && echo 1.0.1 > VERSION && git add VERSION && git -c user.email=user@example.com -c user.name=Robot commit -qm "chore: release versions [skip ci]" && git push -q origin main
fi
EOF
chmod +x .git/hooks/pre-push
rm -f "$TMP/raced"
out="$(bash "$LAND" feature 2>&1)" || fail "land did not recover from the race: $out"
echo "$out" | grep -q "main moved" || fail "the race was not detected: $out"
tip="$(remote_main)"
[ "$(parents "$tip")" -eq 3 ] || fail "after the race, the tip is not a merge"
[ "$(git --git-dir="$TMP/remote.git" log -1 --format=%s "$tip^1")" = "chore: release versions [skip ci]" ] || fail "the merge is not on top of the robot's commit"
rm -f .git/hooks/pre-push

# 3. Local main left flattened by `git pull` (copies of the branch's commits):
#    land resets it and lands the real merge.
fresh
git checkout -q main
git merge -q --no-ff --no-edit feature
robot_bump 1.0.2
git pull -q 2>/dev/null   # pull.rebase=true flattens the merge
[ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" -eq 2 ] || fail "setup: pull did not flatten"
git checkout -q feature
bash "$LAND" feature >/dev/null 2>&1 || fail "land refused a flattened main"
[ "$(parents "$(remote_main)")" -eq 3 ] || fail "flattened main was not replaced by a merge"

# 4. A commit only local main has is somebody's work: refused, main untouched.
fresh
git checkout -q main
echo mine > mine.txt && git add mine.txt && gitq commit -qm "fix: only on local main"
LOCAL="$(git rev-parse main)"
git checkout -q feature
if bash "$LAND" feature >/dev/null 2>&1; then fail "land dropped a local-only commit"; fi
[ "$(git rev-parse main)" = "$LOCAL" ] || fail "local main was moved"
[ "$(git branch --show-current)" = feature ] || fail "did not return after refusing"

# 5. A conflict: nothing is pushed, the merge is aborted, and the operator is
#    back where they started with a clean tree.
fresh
git checkout -q main && echo theirs > base.txt && gitq commit -qam "fix: theirs" && git push -q origin main
git checkout -q feature && echo ours > base.txt && gitq commit -qam "fix: ours"
BEFORE="$(remote_main)"
if bash "$LAND" feature >/dev/null 2>&1; then fail "a conflicting land succeeded"; fi
[ "$(remote_main)" = "$BEFORE" ] || fail "a conflicting land pushed"
[ -z "$(git status --porcelain)" ] || fail "a conflicting land left a dirty tree"
[ "$(git branch --show-current)" = feature ] || fail "did not return after a conflict"

# 6. Tracked edits in the tree: refused before anything moves.
fresh
echo dirty >> one.txt
if bash "$LAND" feature >/dev/null 2>&1; then fail "land ran with uncommitted changes"; fi
git checkout -q one.txt

# 7. check-main-current: a push built on an old main is refused in a second;
#    a push built on the current main, and a push to another branch, pass.
fresh
OLD="$(git rev-parse origin/main)"
robot_bump 1.0.3
if echo "refs/heads/main $(git rev-parse feature) refs/heads/main $OLD" | bash "$CURRENT" origin 2>/dev/null; then
  fail "a push built on an old main was allowed"
fi
NOW="$(remote_main)"
echo "refs/heads/main $(git rev-parse feature) refs/heads/main $NOW" | bash "$CURRENT" origin || fail "a current push was refused"
echo "refs/heads/feature $(git rev-parse feature) refs/heads/feature $OLD" | bash "$CURRENT" origin || fail "a non-main push was judged"

echo "land: 7 cases passed"
