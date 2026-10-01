#!/usr/bin/env bash
# Pins report-run-failures.sh: a failed job files an issue under the given
# label and prefix, a passing first attempt files nothing, a job that failed
# on the previous attempt and passes now is filed as flaky (also when it sits
# inside a called workflow), the body carries the caller's consequence, and
# the job results reach the script through the environment, in the script and
# in every workflow that calls it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/report-run-failures.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CALLS="$TMP/calls"
: > "$CALLS"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
# Keep the last issue body, so a case can assert on what the issue says.
prev=""
for arg in "$@"; do
  [ "$prev" = "--body-file" ] && cp "$arg" "$BODY_COPY"
  prev="$arg"
done
case "$1 $2" in
  "label create") exit 0 ;;
  "issue list") echo '[]' ;;
  "issue create") echo "https://github.com/example/repo/issues/1" ;;
  "api --paginate")
    # The jobs endpoint, one page: every earlier-attempt failure named in
    # $EARLIER_FAILED_NAMES, plus a current-attempt success that must be ignored.
    printf '%s\n' "${EARLIER_FAILED_NAMES:-}" | jq -R -s --argjson a "$GITHUB_RUN_ATTEMPT" \
      '{jobs: ([split("\n")[] | select(length > 0) | {name: ., run_attempt: ($a - 1), conclusion: "failure"}] + [{name: "engine-test (ubuntu-latest)", run_attempt: $a, conclusion: "success"}])}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/gh"
BODY_COPY="$TMP/last-body.md"
export PATH="$TMP/bin:$PATH" CALLS BODY_COPY
export GH_TOKEN=x GITHUB_REPOSITORY=example/repo GITHUB_RUN_ID=99 GITHUB_SHA=abc123 \
  GITHUB_SERVER_URL=https://github.com GITHUB_EVENT_NAME=push

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. One failed job, first attempt: one issue, titled by prefix and job id.
GITHUB_RUN_ATTEMPT=1 NEEDS_JSON='{"engine-test":{"result":"failure"},"desktop-test":{"result":"success"},"relay-test":{"result":"skipped"}}' \
  bash "$SCRIPT" ci-failure "Tests failed on main" >/dev/null
[ "$(grep -c '^issue create' "$CALLS")" -eq 1 ] || fail "expected exactly one issue"
grep -q '^issue create --title Tests failed on main: engine-test --label ci-failure' "$CALLS" || fail "wrong title or label"
grep -q '^api --paginate' "$CALLS" && fail "queried earlier attempts on attempt 1"
grep -q 'The release for this push was not held; fix forward.' "$BODY_COPY" || fail "default consequence missing from the body"

# 2. All green on the first attempt: nothing filed.
: > "$CALLS"
GITHUB_RUN_ATTEMPT=1 NEEDS_JSON='{"engine-test":{"result":"success"}}' \
  bash "$SCRIPT" ci-failure "Tests failed on main" >/dev/null
grep -q '^issue create' "$CALLS" && fail "filed an issue with no failure"

# 3. Attempt 2: a matrix leg that failed on attempt 1 and whose job passes now is flaky.
: > "$CALLS"
GITHUB_RUN_ATTEMPT=2 EARLIER_FAILED_NAMES=$'engine-test (macos-14)\nserver-test' NEEDS_JSON='{"engine-test":{"result":"success"},"server-test":{"result":"failure"}}' \
  bash "$SCRIPT" ci-failure "Tests failed on main" >/dev/null
grep -q '^issue create --title Flaky on main: engine-test (macos-14) --label flaky' "$CALLS" || fail "flaky matrix leg not filed"
grep -q '^issue create --title Tests failed on main: server-test --label ci-failure' "$CALLS" || fail "still-failing job not filed"
grep -q 'Flaky on main: server-test' "$CALLS" && fail "a job that still fails was called flaky"

# 4. A job inside a called workflow is named "<caller job> / <job>" by the
# jobs API; its flake still maps to the job id the reporting job sees.
: > "$CALLS"
GITHUB_RUN_ATTEMPT=2 EARLIER_FAILED_NAMES=$'build / build-desktop\nbuild / build-studio-server (linux, amd64, ubuntu-latest)' NEEDS_JSON='{"build-desktop":{"result":"success"},"build-studio-server":{"result":"success"},"build-server":{"result":"success"}}' \
  bash "$SCRIPT" ci-failure "Release build failed on main" >/dev/null
grep -q '^issue create --title Flaky on main: build / build-desktop --label flaky' "$CALLS" || fail "flaky called-workflow job not filed"
grep -q '^issue create --title Flaky on main: build / build-studio-server (linux, amd64, ubuntu-latest) --label flaky' "$CALLS" || fail "flaky called-workflow matrix leg not filed"
[ "$(grep -c '^issue create' "$CALLS")" -eq 2 ] || fail "expected exactly two flaky issues"

# 5. A caller's consequence replaces the default sentence in the body.
: > "$CALLS"
GITHUB_RUN_ATTEMPT=1 NEEDS_JSON='{"build-desktop":{"result":"failure"}}' \
  bash "$SCRIPT" ci-failure "Release build failed on main" "Its release stays a draft until this job passes." >/dev/null
grep -q '^issue create --title Release build failed on main: build-desktop --label ci-failure' "$CALLS" || fail "wrong title or label for a build failure"
grep -q 'Its release stays a draft until this job passes.' "$BODY_COPY" || fail "caller consequence missing from the body"
grep -q 'was not held' "$BODY_COPY" && fail "default consequence leaked into a build failure"

# 6. A job output with a quote in it, as a release report carries a commit
# subject: the results are read as data, and the failure is still filed.
: > "$CALLS"
GITHUB_RUN_ATTEMPT=1 NEEDS_JSON='{"release":{"result":"failure","outputs":{"release_report":"it'"'"'s (#1) $(exit 1) `exit 1`"}}}' \
  bash "$SCRIPT" ci-failure "Release failed on main" >/dev/null
grep -q '^issue create --title Release failed on main: release --label ci-failure' "$CALLS" || fail "a quote in a job output lost the failure"

# 7. No workflow pastes an expression into this script's command line; that
# is where a quote in a job output becomes shell syntax.
CALLERS="$(grep -n 'report-run-failures\.sh' "$SCRIPT_DIR"/../workflows/*.yml)"
[ -n "$CALLERS" ] || fail "no workflow calls the script"
echo "$CALLERS" | grep -F '${{' && fail "a workflow passes an expression on the command line"
[ "$(echo "$CALLERS" | wc -l)" -eq "$(grep -c 'NEEDS_JSON: \${{ toJSON(needs) }}' "$SCRIPT_DIR"/../workflows/*.yml | awk -F: '{n+=$NF} END {print n}')" ] \
  || fail "a workflow calls the script without NEEDS_JSON"

echo "report-run-failures: 7 cases passed"
