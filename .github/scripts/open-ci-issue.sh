#!/usr/bin/env bash
# open-ci-issue.sh — Turn a CI finding into a GitHub issue without blocking
# anything.
#
# The delivery pipeline ships every push to main. A failing test, a failing
# install smoke, or a new security advisory is recorded here as an issue the
# operator triages, never as a red release. One open issue per title: a repeat
# of the same finding lands as a comment on the existing issue, so a flaky or
# long-lived failure has one thread, not one issue per push.
#
# Usage:
#   open-ci-issue.sh <label> <title> <body-file>
#
# Dependencies: gh (authenticated via GH_TOKEN), on ubuntu-latest runners.

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <label> <title> <body-file>" >&2
  exit 1
fi

LABEL="$1"
TITLE="$2"
BODY_FILE="$3"

if [ ! -f "$BODY_FILE" ]; then
  echo "open-ci-issue: body file not found: $BODY_FILE" >&2
  exit 1
fi

# The label must exist before an issue can carry it. --force makes this a
# no-op when it already does, so every workflow can call this cold.
gh label create "$LABEL" --force --color D93F0B \
  --description "Opened by the delivery pipeline; see .github/scripts/open-ci-issue.sh" >/dev/null

# gh's --search matches words, not the exact title, so the exact match is
# applied here on the returned list.
EXISTING="$(gh issue list --state open --label "$LABEL" --search "in:title \"$TITLE\"" --json number,title \
  | jq -r --arg t "$TITLE" '[.[] | select(.title == $t)][0].number // empty')"

if [ -n "$EXISTING" ]; then
  gh issue comment "$EXISTING" --body-file "$BODY_FILE" >/dev/null
  echo "open-ci-issue: commented on existing issue #$EXISTING: $TITLE"
  echo "issue=$EXISTING" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

URL="$(gh issue create --title "$TITLE" --label "$LABEL" --body-file "$BODY_FILE")"
echo "open-ci-issue: opened $URL: $TITLE"
echo "issue=${URL##*/}" >> "${GITHUB_OUTPUT:-/dev/null}"
