#!/usr/bin/env bash
# Regression coverage for scripts/check-logging-reserved-keys.py (the
# RESERVED-KEY category of check-logging.sh): it flags a machine-identity key
# at a logger call site, including one on a later line of a multi-line field
# object, and leaves renamed keys, values, and opted-out lines alone.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d -t check-logging-reserved-keys.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

cat > "$TMP/a.ts" <<'TS'
log('x', 'shorthand', { host })
debug('favicon', 'multi-line', {
  status: 1,
  host: url,
})
log('x', 'renamed', { url_host: host })
log('x', 'opted out', { host: h }) // log-key-ok: the machine's own name
const cfg = { host: 'not a log call' }
TS
cat > "$TMP/b.go" <<'GO'
package x
func f() {
	utils.LogWithFields(utils.LevelInfo, "t", "m", map[string]any{
		"server": 1, "machine_id": h,
	})
	utils.LogWithFields(utils.LevelInfo, "t", "m", map[string]any{"url_host": h})
	cfg := map[string]any{"host": "not a log call"}
}
GO

OUT="$(printf '%s\n' "$TMP/a.ts" "$TMP/b.go" | python3 "$REPO_ROOT/scripts/check-logging-reserved-keys.py")"
want="$TMP/a.ts:1:
$TMP/a.ts:4:
$TMP/b.go:4:"
got="$(sed -E 's/^([^:]+:[0-9]+:).*/\1/' <<<"$OUT")"
[ "$got" = "$want" ] || fail "unexpected findings:"$'\n'"$OUT"
echo "check-logging-reserved-keys.test.sh: ok"
