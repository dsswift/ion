#!/usr/bin/env bash
# Classify current checkout for graphify mutation targets.
#
# Graphs belong to the primary checkout. A linked worktree may query its
# primary graph through a provisioned file link, but must never rebuild it.
# Callers inspect GRAPHIFY_WORKTREE_GUARD: `primary` or `worktree`.

set -uo pipefail

GITDIR=$(git rev-parse --git-dir 2>/dev/null) || {
    echo "graphify: cannot determine git directory; refusing graph mutation" >&2
    exit 2
}
COMMONDIR=$(git rev-parse --git-common-dir 2>/dev/null) || {
    echo "graphify: cannot determine shared git directory; refusing graph mutation" >&2
    exit 2
}
GITDIR=$(cd "$GITDIR" 2>/dev/null && pwd) || {
    echo "graphify: cannot resolve git directory; refusing graph mutation" >&2
    exit 2
}
COMMONDIR=$(cd "$COMMONDIR" 2>/dev/null && pwd) || {
    echo "graphify: cannot resolve shared git directory; refusing graph mutation" >&2
    exit 2
}

if [ "$GITDIR" = "$COMMONDIR" ]; then
    GRAPHIFY_WORKTREE_GUARD=primary
    GRAPHIFY_PRIMARY_CHECKOUT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 2
else
    GRAPHIFY_WORKTREE_GUARD=worktree
    # Git prints the primary checkout first. A detached checkout has no `branch`
    # stanza, so select its `worktree` record directly rather than waiting for
    # a branch record that may belong to a linked worktree.
    GRAPHIFY_PRIMARY_CHECKOUT=$(git worktree list --porcelain 2>/dev/null | awk '
        /^worktree / && !seen { print substr($0, 10); seen = 1; exit }
    ')
    if [ -z "$GRAPHIFY_PRIMARY_CHECKOUT" ]; then
        echo "graphify: cannot determine primary checkout; refusing graph mutation" >&2
        exit 2
    fi
fi

export GRAPHIFY_WORKTREE_GUARD GRAPHIFY_PRIMARY_CHECKOUT
printf '%s %s\n' "$GRAPHIFY_WORKTREE_GUARD" "$GRAPHIFY_PRIMARY_CHECKOUT"
