#!/usr/bin/env bash
# Walk repository, create CLAUDE.md symlink next to each AGENTS.md so Claude Code
# (which reads CLAUDE.md but not AGENTS.md) auto-loads the canonical AGENTS.md.
# CLAUDE.md is gitignored; AGENTS.md is the committed canonical artifact.
#
# Idempotent. Safe to run repeatedly. Wired into:
#   - desktop/package.json postinstall
#   - make claude-symlinks (root Makefile)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

created=0
already=0
blocked=0

# Find every committed AGENTS.md; ignore node_modules, build outputs, .git.
while IFS= read -r agents_path; do
  dir="$(dirname "$agents_path")"
  claude_path="$dir/CLAUDE.md"
  target="AGENTS.md"  # relative to the symlink's own directory

  if [ -L "$claude_path" ]; then
    # Existing symlink. Verify it points to AGENTS.md; otherwise refresh.
    current="$(readlink "$claude_path")"
    if [ "$current" = "$target" ]; then
      already=$((already + 1))
      continue
    fi
    rm "$claude_path"
    ln -s "$target" "$claude_path"
    created=$((created + 1))
    echo "refresh: $claude_path -> $target"
  elif [ -e "$claude_path" ]; then
    # Real file (not a symlink) blocks creation. Refuse to clobber.
    echo "ERROR: $claude_path exists as a real file, not a symlink." >&2
    echo "  Most common cause: a stale CLAUDE.md left over from when AGENTS.md" >&2
    echo "  was renamed. To fix:" >&2
    echo "    git rm --cached '$claude_path' 2>/dev/null || true" >&2
    echo "    rm '$claude_path'" >&2
    echo "    bash scripts/setup-claude-symlinks.sh" >&2
    echo "  If the file has unique content you need to keep, copy it elsewhere first." >&2
    blocked=$((blocked + 1))
  else
    ln -s "$target" "$claude_path"
    created=$((created + 1))
    echo "create:  $claude_path -> $target"
  fi
done < <(
  find . \
    -type d \( -name node_modules -o -name dist -o -name out -o -name release -o -name build -o -name .git -o -name DerivedData \) -prune -false \
    -o -type f -name AGENTS.md -print
)

echo
echo "summary: created=$created already=$already blocked=$blocked"

if [ "$blocked" -gt 0 ]; then
  exit 1
fi
