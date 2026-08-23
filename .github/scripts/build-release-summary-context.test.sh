#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORMATTER="$SCRIPT_DIR/build-release-summary-context.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export RELEASE_REPORT='{
  "releases": [
    {
      "component": "desktop",
      "new_version": "1.86.0",
      "release_url": "https://example.org/releases/desktop-v1.86.0",
      "commits": [
        {
          "sha": "07556c5e15443e8f36ef16271206942a4e3bbb95",
          "type": "feat",
          "scope": "desktop",
          "description": "improve Studio workflows"
        }
      ]
    },
    {
      "component": "engine",
      "new_version": "1.74.0",
      "release_url": null,
      "commits": []
    }
  ]
}'

OUTPUT="$TMP_DIR/context.md"
bash "$FORMATTER" "$OUTPUT"

cat > "$TMP_DIR/expected.md" <<'EXPECTED'
## desktop v1.86.0
Release: https://example.org/releases/desktop-v1.86.0
Commits:
- feat(desktop): improve Studio workflows (07556c5)

## engine v1.74.0
Release: not available
Commits: none (linked version update)

EXPECTED

diff -u "$TMP_DIR/expected.md" "$OUTPUT"
echo "release summary context test: OK"
