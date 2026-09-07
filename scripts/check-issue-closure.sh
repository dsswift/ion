#!/usr/bin/env bash
# Verifies that every issue a PR claims to resolve actually closes when the
# PR merges. AGENTS.md's commit convention appends "(#N)" to a commit
# subject when work was initiated by issue #N; GitHub only closes that issue
# on merge if a real closing keyword ("Fixes #N", "Closes #N", etc.) appears
# in the PR body or a commit body. "(#N)" alone is just a link. This check
# catches the gap mechanically instead of relying on remembering the rule.
#
# Usage: scripts/check-issue-closure.sh [PR_NUMBER]
# With no argument, resolves the PR for the current branch via `gh pr view`.
set -euo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || true)
fi
if [[ -z "$PR_NUMBER" ]]; then
  echo "check-issue-closure: no PR number given and none found for the current branch, skipping" >&2
  exit 0
fi

pr_json=$(gh pr view "$PR_NUMBER" --json title,body,commits)
title=$(jq -r '.title' <<<"$pr_json")
body=$(jq -r '.body // ""' <<<"$pr_json")
commit_text=$(jq -r '.commits[] | (.messageHeadline // "") + "\n" + (.messageBody // "")' <<<"$pr_json")

referenced=$(grep -ohE '\(#[0-9]+\)' <<<"$title"$'\n'"$commit_text" | grep -oE '[0-9]+' | sort -un || true)
closed=$(grep -ohiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+' <<<"$body"$'\n'"$commit_text" | grep -oE '[0-9]+' | sort -un || true)

missing=()
for n in $referenced; do
  if ! grep -qx "$n" <<<"$closed"; then
    missing+=("$n")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "check-issue-closure: FAILED" >&2
  echo "These issues are referenced as (#N) in the title/commits but have no" >&2
  echo "'Fixes #N' / 'Closes #N' keyword anywhere in the PR body or a commit body," >&2
  echo "so GitHub will NOT close them when this PR merges:" >&2
  for n in "${missing[@]}"; do
    echo "  - #$n" >&2
  done
  echo "" >&2
  echo "Add a 'Fixes #N' or 'Closes #N' line to the PR body (or a commit body) for each." >&2
  exit 1
fi

echo "check-issue-closure: OK"
