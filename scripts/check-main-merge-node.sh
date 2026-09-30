#!/usr/bin/env bash
# check-main-merge-node.sh — Refuse a push that would move main without a
# merge commit at its tip.
#
# main's history is made of merge nodes: one per piece of work, each carrying
# the branch it came from. A fast-forward of a feature branch, or a commit
# made straight on main, leaves no node, and release-damnit reads the commit
# graph through those nodes. So the tip of every push to main must be a merge
# commit. `branch.main.mergeoptions --no-ff` (set by `make bootstrap`) makes
# a plain `git merge` on main produce one.
#
# Reads the pre-push ref lines from stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
# and exits 1 when a line updates refs/heads/main to a non-merge tip. A push
# that creates main (remote sha all zeros) or deletes it (local sha all zeros)
# is not judged here. Usage from the hook:
#
#   scripts/check-main-merge-node.sh < "$PRE_PUSH_STDIN_FILE"

set -euo pipefail

ZERO="0000000000000000000000000000000000000000"
MAIN_REF="${ION_MAIN_REF:-refs/heads/main}"
status=0

while read -r _local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = "$MAIN_REF" ] || continue
  [ "$local_sha" != "$ZERO" ] || continue
  [ "$remote_sha" != "$ZERO" ] || continue
  [ "$local_sha" != "$remote_sha" ] || continue
  parents="$(git rev-list --parents -n 1 "$local_sha" | wc -w | tr -d ' ')"
  if [ "$parents" -lt 3 ]; then
    echo "pre-push: refusing to move $MAIN_REF to ${local_sha:0:9}: its tip is not a merge commit." >&2
    echo "  main keeps a merge node per piece of work. On main: git merge <branch>" >&2
    echo "  (--no-ff is the default there after make bootstrap), then push." >&2
    status=1
  fi
done

exit "$status"
