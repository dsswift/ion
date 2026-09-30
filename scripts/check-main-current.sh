#!/usr/bin/env bash
# check-main-current.sh — Refuse, in a second, a push to main that the remote
# will refuse anyway because main moved there.
#
# The delivery pipeline pushes a version-bump commit to main after every
# landing. A push built on the main from before that commit is rejected by
# the server, but only after the pre-push gates have run. This check asks the
# remote first, so a lost race costs one round trip instead of the gates.
#
# Reads the pre-push ref lines from stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
# where <remote sha> is what this clone last saw of the remote branch.
# Usage: check-main-current.sh <remote name or url>
#
# An unreachable remote is not judged here: the push itself will say so.

set -euo pipefail

REMOTE="${1:?usage: check-main-current.sh <remote>}"
ZERO="0000000000000000000000000000000000000000"
MAIN_REF="${ION_MAIN_REF:-refs/heads/main}"
status=0

while read -r _local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = "$MAIN_REF" ] || continue
  [ "$local_sha" != "$ZERO" ] || continue
  [ "$remote_sha" != "$ZERO" ] || continue
  if ! actual="$(git ls-remote "$REMOTE" "$MAIN_REF" 2>/dev/null | cut -f1)"; then
    echo "pre-push: could not read $MAIN_REF from $REMOTE; the push will report it" >&2
    continue
  fi
  [ -n "$actual" ] || continue
  if [ "$actual" != "$remote_sha" ]; then
    echo "pre-push: $MAIN_REF moved on $REMOTE (it is at ${actual:0:9}, this push was built on ${remote_sha:0:9})." >&2
    echo "  The pipeline pushes a version commit after every landing. Land again:" >&2
    echo "    make land <branch>" >&2
    status=1
  fi
done

exit "$status"
