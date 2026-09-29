#!/usr/bin/env bash
# check-studio-wire — golden-fixture version gate for the Studio wire
# protocol (manifest contract C3, Ion Studio Server program child 07).
#
# `packages/shared/src/studio-wire/__fixtures__/v1/*.json` pins one JSON
# example per StudioFrame type, byte-for-byte round-tripped by codec tests in
# packages/shared, server, and desktop. When a fixture changes or a new one
# is added, the wire shape moved -- and that is either a new protocol
# version or a documented note under the current one. Either way,
# `docs/protocol/studio-wire.md` must be touched in the same change, with a
# `## v<N>` heading present. A fixture diff with no matching doc change is
# refused.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_REF="${STUDIO_WIRE_BASE_REF:-origin/main}"

# A detached/shallow clone (or a repo with no origin/main reachable, e.g. a
# fresh worktree before its first fetch) can't diff against BASE_REF -- fall
# back to comparing against the empty tree so the check still runs (treating
# every current fixture as "changed" the first time this ever executes) but
# never crashes CI on a plumbing error.
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "check-studio-wire: $BASE_REF not found locally; comparing against the empty tree" >&2
  BASE_REF="$(git hash-object -t tree /dev/null)"
fi

# Committed changes plus not-yet-added new fixtures/docs -- `git diff`
# alone only sees tracked changes, so a brand-new fixture file (added but
# not yet `git add`ed) would otherwise slip past this gate entirely.
# Deliberately omits `--exclude-standard`: a contributor's global gitignore
# (e.g. a stray `**/[Pp]ackages/*` rule from an unrelated .NET/NuGet
# convention) can shadow files under this repo's `packages/` npm workspace
# without their knowledge -- a real failure mode observed while building
# this gate, where every new file under `packages/shared/src/studio-wire/`
# silently vanished from `git status`. A committed fixture is never a build
# artifact, so treating an "ignored" file under this narrow path as new is
# safe and closes that gap rather than reproducing it.
changed_or_new() {
  {
    git diff --name-only "$BASE_REF" -- "$1" || true
    git ls-files --others -- "$1" || true
  } | sort -u
}

FIXTURE_DIFF=$(changed_or_new packages/shared/src/studio-wire/__fixtures__)

if [ -z "$FIXTURE_DIFF" ]; then
  echo "check-studio-wire: OK (no fixture changes)"
  exit 0
fi

DOC_PATH="docs/protocol/studio-wire.md"
DOC_DIFF=$(changed_or_new "$DOC_PATH")

if [ -z "$DOC_DIFF" ]; then
  echo "check-studio-wire: fixtures changed but $DOC_PATH was not touched."
  echo "Changed fixtures:"
  echo "$FIXTURE_DIFF"
  echo
  echo "Add a '## v<N>' section to $DOC_PATH describing the change (a new"
  echo "version if the wire shape is incompatible, or a note under the"
  echo "current version for an additive fixture)."
  exit 1
fi

if ! grep -qE '^## v[0-9]+' "$DOC_PATH"; then
  echo "check-studio-wire: $DOC_PATH has no '## v<N>' heading."
  exit 1
fi

echo "check-studio-wire: OK (fixtures changed, $DOC_PATH updated with a version heading)"
