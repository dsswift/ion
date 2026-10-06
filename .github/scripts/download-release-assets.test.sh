#!/usr/bin/env bash
# Pins download-release-assets.sh against a fake gh: a failed download is
# retried until it succeeds, it gives up after the attempt limit, and an old
# checksums.txt never survives into the directory to be hashed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/download-release-assets.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# The fake fails its first $FAIL_TIMES calls, then writes an asset and the
# checksums.txt an earlier run uploaded.
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$TMP/calls"
n=$(wc -l < "$TMP/calls")
if [ "$n" -le "${FAIL_TIMES:-0}" ]; then
  echo "HTTP 500" >&2
  exit 1
fi
dir=""
while [ $# -gt 0 ]; do
  [ "$1" = "-D" ] && dir="$2"
  shift
done
mkdir -p "$dir"
echo binary > "$dir/ion-linux-amd64"
echo stale > "$dir/checksums.txt"
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH" TMP RELEASE_DOWNLOAD_BACKOFF=0

fail() { echo "FAIL: $*" >&2; exit 1; }

# Two failures, then a success: retried, and the old checksums are dropped.
: > "$TMP/calls"
FAIL_TIMES=2 bash "$SCRIPT" example/repo engine-v1.2.3 "$TMP/assets" > /dev/null 2>&1 || fail "did not recover from transient failures"
[ "$(wc -l < "$TMP/calls")" -eq 3 ] || fail "want 3 gh calls, got $(wc -l < "$TMP/calls")"
grep -q -- 'release download engine-v1.2.3 -R example/repo -D '"$TMP/assets"' --clobber' "$TMP/calls" || fail "gh args wrong: $(head -1 "$TMP/calls")"
[ -f "$TMP/assets/ion-linux-amd64" ] || fail "asset not downloaded"
[ ! -e "$TMP/assets/checksums.txt" ] || fail "old checksums.txt kept"

# Failing every attempt gives up with an error after the limit.
: > "$TMP/calls"
status=0
FAIL_TIMES=99 RELEASE_DOWNLOAD_ATTEMPTS=3 bash "$SCRIPT" example/repo engine-v1.2.3 "$TMP/assets2" > /dev/null 2>&1 || status=$?
[ "$status" -eq 1 ] || fail "exhausted retries exit = $status, want 1"
[ "$(wc -l < "$TMP/calls")" -eq 3 ] || fail "want 3 attempts, got $(wc -l < "$TMP/calls")"

echo "download-release-assets.test.sh: ok"
