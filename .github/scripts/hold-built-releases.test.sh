#!/usr/bin/env bash
# Pins hold-built-releases.sh: built components are drafted, unbuilt ones are
# published non-latest, and the tag comes from the report, never from string
# assembly (sdk/go's tag has its own separator).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/hold-built-releases.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CALLS="$TMP/calls"
: > "$CALLS"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH" CALLS

fail() { echo "FAIL: $*" >&2; exit 1; }

export RELEASE_REPORT='{"releases":[
  {"component":"engine","tag_name":"engine-v1.2.3"},
  {"component":"desktop","tag_name":"desktop-v2.0.0"},
  {"component":"sdk/go","tag_name":"sdk/go/v0.1.9"},
  {"component":"ios","tag_name":"ios-v2.0.0"}
]}'
bash "$SCRIPT" >/dev/null

grep -qx 'release edit engine-v1.2.3 --draft=true' "$CALLS" || fail "engine not drafted"
grep -qx 'release edit desktop-v2.0.0 --draft=true' "$CALLS" || fail "desktop not drafted"
grep -qx 'release edit sdk/go/v0.1.9 --draft=false --latest=false' "$CALLS" || fail "sdk not published with its own tag form"
grep -qx 'release edit ios-v2.0.0 --draft=false --latest=false' "$CALLS" || fail "ios not published"
[ "$(wc -l < "$CALLS")" -eq 4 ] || fail "unexpected gh calls: $(cat "$CALLS")"

# An empty report is a no-op, not an error.
: > "$CALLS"
RELEASE_REPORT='{"releases":[]}' bash "$SCRIPT" >/dev/null
[ ! -s "$CALLS" ] || fail "empty report made gh calls"

echo "hold-built-releases: 2 cases passed"
