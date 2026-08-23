#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: build-release-summary-context.sh <output-path>" >&2
  exit 2
fi

: "${RELEASE_REPORT:?RELEASE_REPORT is required}"

jq -r '
  .releases[] |
  "## \(.component) v\(.new_version)",
  "Release: \(.release_url // "not available")",
  (if ((.commits // []) | length) > 0 then
    "Commits:",
    (.commits[] |
      "- \(.type)" +
      (if .scope then "(\(.scope))" else "" end) +
      ": \(.description) (\(.sha[0:7]))"
    )
   else
    "Commits: none (linked version update)"
   end),
  ""
' <<< "$RELEASE_REPORT" > "$1"
