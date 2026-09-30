#!/usr/bin/env bash
# Pins open-ci-issue.sh against a fake gh: a new title opens an issue, a
# repeated title comments on the open one, and the label is always ensured.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/open-ci-issue.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CALLS="$TMP/calls"
: > "$CALLS"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$1 $2" in
  "label create") exit 0 ;;
  "issue list")
    # The fake's open issue list comes from $OPEN_ISSUES (JSON array).
    printf '%s' "${OPEN_ISSUES:-[]}" ;;
  "issue comment") exit 0 ;;
  "issue create") echo "https://github.com/example/repo/issues/42" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
export CALLS
export GITHUB_OUTPUT="$TMP/out"

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "body" > "$TMP/body.md"

# 1. No open issue with this title: creates one and records its number.
OPEN_ISSUES='[]' bash "$SCRIPT" ci-failure "Tests failed on main: engine-test (ubuntu-latest)" "$TMP/body.md" >/dev/null
grep -q '^label create ci-failure --force' "$CALLS" || fail "label was not ensured"
grep -q '^issue create --title Tests failed on main: engine-test (ubuntu-latest) --label ci-failure' "$CALLS" || fail "issue was not created"
grep -q '^issue=42$' "$GITHUB_OUTPUT" || fail "issue number not written to GITHUB_OUTPUT"

# 2. An open issue with the exact title: comments instead of creating.
: > "$CALLS"; : > "$GITHUB_OUTPUT"
OPEN_ISSUES='[{"number":7,"title":"Tests failed on main: engine-test (ubuntu-latest)"},{"number":8,"title":"Tests failed on main: engine-test (macos-14)"}]' \
  bash "$SCRIPT" ci-failure "Tests failed on main: engine-test (ubuntu-latest)" "$TMP/body.md" >/dev/null
grep -q '^issue comment 7 ' "$CALLS" || fail "did not comment on the matching open issue"
grep -q '^issue create' "$CALLS" && fail "created a duplicate issue"
grep -q '^issue=7$' "$GITHUB_OUTPUT" || fail "existing issue number not written"

# 3. A word-overlapping but different title does not match.
: > "$CALLS"
OPEN_ISSUES='[{"number":8,"title":"Tests failed on main: engine-test (macos-14)"}]' \
  bash "$SCRIPT" ci-failure "Tests failed on main: engine-test (ubuntu-latest)" "$TMP/body.md" >/dev/null
grep -q '^issue create' "$CALLS" || fail "a different title was treated as the same issue"

# 4. A missing body file is an error, not an empty issue.
if bash "$SCRIPT" ci-failure "x" "$TMP/missing.md" 2>/dev/null; then
  fail "missing body file was accepted"
fi

echo "open-ci-issue: 4 cases passed"
