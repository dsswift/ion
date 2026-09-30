#!/usr/bin/env bash
# land.sh — Land a branch on main as one merge node, and push it.
#
#   make land <branch>
#
# main is made of merge nodes, and the delivery pipeline pushes a version
# commit to main after every landing. Landing by hand races that commit: a
# merge built on the main from a minute ago is rejected, and a plain
# `git pull` on main flattens the merge. This does the whole landing in one
# step and retries the race on its own:
#
#   1. fetch main, and set local main to it
#   2. merge <branch> with --no-ff (the merge node)
#   3. push; the pre-push hook runs its checks
#   4. if main moved on the remote meanwhile, start over from 1
#
# Local main never carries work of its own, so step 1 resets it. The one
# exception is refused rather than lost: a commit on local main that is not
# on the remote and is not a copy of a commit on <branch>.
#
# Returns to the branch it started on, however it exits.

set -euo pipefail

BRANCH="${1:-}"
REMOTE="${ION_LAND_REMOTE:-origin}"
MAX_ATTEMPTS="${ION_LAND_ATTEMPTS:-5}"

fail() { echo "land: $*" >&2; exit 1; }

[ -n "$BRANCH" ] || fail "usage: make land <branch>"
[ "$BRANCH" != "main" ] || fail "main cannot be landed on itself"
git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null || fail "no local branch named $BRANCH"
# Untracked files survive a checkout; tracked edits would ride into the merge.
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "commit or stash your changes first"

START="$(git branch --show-current)"
[ -n "$START" ] || START="$(git rev-parse HEAD)"
restore() {
  local code=$?
  if [ "$(git branch --show-current)" != "$START" ] && [ "$(git rev-parse HEAD)" != "$START" ]; then
    git checkout --quiet "$START" || echo "land: could not return to $START" >&2
  fi
  exit "$code"
}
trap restore EXIT

attempt=1
while :; do
  echo "land: attempt $attempt: fetching $REMOTE/main"
  git fetch --quiet "$REMOTE" main
  BASE="$(git rev-parse "refs/remotes/$REMOTE/main")"

  # Local main may hold only what the remote has, plus copies of <branch>'s
  # own commits (what a flattening `git pull` leaves behind). Anything else is
  # somebody's work, and resetting main would drop it.
  if git show-ref --verify --quiet refs/heads/main; then
    stray="$(git rev-list --cherry-pick --right-only --no-merges "$BRANCH...main" "^$BASE")"
    [ -z "$stray" ] || fail "local main has commits that are not on $REMOTE and not on $BRANCH; move them to a branch first: $(echo "$stray" | head -3 | cut -c1-9 | tr '\n' ' ')"
  fi

  git checkout --quiet -B main "$BASE"
  git branch --quiet --set-upstream-to="$REMOTE/main" main
  if ! git merge --quiet --no-ff --no-edit "$BRANCH"; then
    git merge --abort || true
    git reset --quiet --hard "$BASE"
    fail "$BRANCH does not merge cleanly into main. Rebase $BRANCH onto main, resolve the conflicts there, and land again."
  fi

  if git push "$REMOTE" main; then
    echo "land: $BRANCH landed on main at $(git rev-parse --short HEAD)"
    exit 0
  fi

  # A push can fail for two reasons: main moved on the remote (the race this
  # script exists for, so go again), or the hook refused. Only the first is
  # retried; the second is the operator's to read.
  NOW="$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)"
  git reset --quiet --hard "$BASE"
  if [ -z "$NOW" ] || [ "$NOW" = "$BASE" ]; then
    fail "the push was refused and main did not move; read the hook output above"
  fi
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    fail "main kept moving on $REMOTE; gave up after $attempt attempts"
  fi
  echo "land: main moved on $REMOTE (now ${NOW:0:9}); merging again on top of it"
  attempt=$((attempt + 1))
done
