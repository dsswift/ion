#!/usr/bin/env bash
# report-run-failures.sh — File one issue per failed job of the current
# workflow run, and one per job that failed on an earlier attempt of this
# same run and passed on this one (a flaky job).
#
# This is the tail of every lane: the test lane (quality.yml), the nightly
# security lane (security.yml), and the release lane (release.yml and the
# build.yml it calls). The run's result stays whatever it is; the operator's
# inbox is the issue list.
#
# Usage:
#   report-run-failures.sh <label> <title-prefix> <needs-json> [consequence]
#
#   needs-json is `toJSON(needs)` from the reporting job: a map of job id to
#   { result, outputs }. Matrix legs collapse into their job id; the issue
#   links the run, where the leg is one click away.
#
#   consequence is the sentence in the issue body that says what the failure
#   did to the release. It defaults to the non-blocking lanes' answer.
#
# Environment (all set by GitHub Actions):
#   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
#   GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_EVENT_NAME
#
# Dependencies: gh, jq, and open-ci-issue.sh beside this script.

set -euo pipefail

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "Usage: $0 <label> <title-prefix> <needs-json> [consequence]" >&2
  exit 1
fi

LABEL="$1"
PREFIX="$2"
NEEDS="$3"
CONSEQUENCE="${4:-The release for this push was not held; fix forward.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

filed=0

FAILED="$(echo "$NEEDS" | jq -r 'to_entries[] | select(.value.result == "failure") | .key')"
for job in $FAILED; do
  cat > "$TMP/body.md" <<EOF
\`${job}\` failed on \`main\` (${GITHUB_EVENT_NAME}, attempt ${ATTEMPT}). ${CONSEQUENCE}

- Run: ${RUN_URL}
- Commit: ${GITHUB_SHA}

Rerun only the failed jobs from the run page; passed jobs are kept.
EOF
  bash "$SCRIPT_DIR/open-ci-issue.sh" "$LABEL" "${PREFIX}: ${job}" "$TMP/body.md"
  filed=$((filed + 1))
done

# A job that failed on an earlier attempt and passes now did so on the same
# commit: nothing changed but the run. That is the definition of flaky, and
# it is a bug to fix the day it appears, not a rerun to shrug at.
if [ "$ATTEMPT" -gt 1 ]; then
  PASSED_NOW="$(echo "$NEEDS" | jq -r 'to_entries[] | select(.value.result == "success") | .key')"
  # The jobs API names a job by its display name; a matrix leg is
  # "<job> (<leg>)", and a job inside a called workflow is
  # "<caller job> / <job>". Match on the job id so a leg that flaked maps to
  # the job that now reports success.
  EARLIER_FAILURES="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?filter=all&per_page=100" \
    | jq -r --argjson a "$ATTEMPT" '.jobs[] | select(.run_attempt < $a and .conclusion == "failure") | .name' | sort -u)"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    for job in $PASSED_NOW; do
      case "$name" in
        "$job"|"$job ("*|*" / $job"|*" / $job ("*)
          cat > "$TMP/body.md" <<EOF
\`${name}\` failed on attempt $((ATTEMPT - 1)) of this run and passed on attempt ${ATTEMPT}, on the same commit. That is a flaky test, and it is a bug.

- Run: ${RUN_URL}
- Commit: ${GITHUB_SHA}
EOF
          bash "$SCRIPT_DIR/open-ci-issue.sh" flaky "Flaky on main: ${name}" "$TMP/body.md"
          filed=$((filed + 1))
          ;;
      esac
    done
  done <<< "$EARLIER_FAILURES"
fi

echo "report-run-failures: filed ${filed} issue(s)"
