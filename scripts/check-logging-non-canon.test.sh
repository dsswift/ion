#!/usr/bin/env bash
# Regression coverage for the NON-CANON check (scripts/check-logging-non-canon.sh):
# it flags a drifted field key at a logger call site and leaves wire payloads
# alone: a Go struct JSON tag and a Swift raw-string JSON fixture.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d -t check-logging-non-canon.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

FOUND="$TMP/found"
: > "$FOUND"
report() { echo "$2:$3" >> "$FOUND"; }
# shellcheck source=scripts/check-logging-non-canon.sh
source "$REPO_ROOT/scripts/check-logging-non-canon.sh"

cat > "$TMP/a.swift" <<'SWIFT'
DiagnosticLog.log("done", tag: "x", fields: ["durationMs": ms])
static let fixture = #"{"url":"u","durationMs":412}"#
SWIFT
cat > "$TMP/b.go" <<'GO'
package x
type T struct { D int `json:"durationMs"` }
func f() { utils.LogWithFields(utils.LevelInfo, "t", "m", map[string]any{"runID": id}) }
GO

check_non_canon "$TMP/a.swift" "$TMP/b.go"
want="$TMP/a.swift:1
$TMP/b.go:3"
got="$(cat "$FOUND")"
[ "$got" = "$want" ] || fail "unexpected findings:"$'\n'"$got"
echo "check-logging-non-canon.test.sh: ok"
