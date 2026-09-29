#!/usr/bin/env bash
# Fails the build when a relative markdown link inside a tracked *.md file
# points at a file that does not exist. Scoped to genuinely relative links
# (no scheme, not a bare in-page `#anchor`) so external URLs, mailto links,
# and same-file anchors are never flagged. CHANGELOG.md files are excluded:
# release-please generates them as a historical record, and past entries
# legitimately reference files later renamed or removed.
#
# Added by the Ion Studio Server program's repo-restructure child alongside
# the ADR renumbering it exists to protect: a renumber that misses one
# reference is exactly the defect this script catches on every future PR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAILED=0
CHECKED=0

while IFS= read -r -d '' file; do
  dir="$(dirname "$file")"
  # Strip fenced code blocks (```...```) and inline code spans (`...`) before
  # scanning: both routinely contain link-shaped example syntax
  # (`[label](target.md)` as a literal illustration of Markdown syntax) that
  # is prose, not a real link, and must never be resolved as a path.
  scan_text="$(python3 -c '
import re, sys
text = sys.stdin.read()
text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
text = re.sub(r"`[^`\n]*`", "", text)
sys.stdout.write(text)
' < "$file")"
  # Extract markdown link targets: [text](target). Strip an optional
  # trailing "title" and #fragment.
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    # Skip absolute URLs, mailto, in-page anchors, and repo-root-relative
    # links starting with '/' (those are GitHub-relative, not filesystem
    # relative from the markdown file's own directory).
    case "$target" in
      http://*|https://*|mailto:*|\#*|/*) continue ;;
    esac
    # Strip a trailing #fragment.
    target_path="${target%%#*}"
    [[ -z "$target_path" ]] && continue
    CHECKED=$((CHECKED + 1))
    resolved="$dir/$target_path"
    if [[ ! -e "$resolved" ]]; then
      echo "❌ $file: broken relative link -> $target"
      FAILED=1
    fi
  done < <(printf '%s' "$scan_text" | grep -oE '\]\([^)]+\)' | sed -E 's/^\]\(([^)]+)\)$/\1/' | sed -E 's/ "[^"]*"$//')
done < <(git ls-files -z '*.md' | grep -zv '\(^\|/\)CHANGELOG\.md$')

if [[ "$FAILED" -eq 1 ]]; then
  echo ""
  echo "check-doc-links: FAILED"
  exit 1
fi

echo "check-doc-links: OK ($CHECKED relative links checked)"
