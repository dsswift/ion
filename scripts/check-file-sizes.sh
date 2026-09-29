#!/usr/bin/env bash
# CI-grade file-size guardrail. Fails the build when source files exceed the
# language hard cap unless they appear in .file-size-allowlist.yml or carry a
# top-of-file `@file-size-exception:` annotation.
#
# Caps are documented in docs/architecture/file-organization.md.
# Override mechanics:
#   1. Add the path to .file-size-allowlist.yml during transition.
#   2. Annotate the first line: `// @file-size-exception: <reason>` (TS/Go/Swift)
#                          or  `# @file-size-exception: <reason>` (shell/yaml/python)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ALLOWLIST="$REPO_ROOT/.file-size-allowlist.yml"

# Hard caps (lines). Soft targets are advisory only and not enforced here.
TS_CAP=600
GO_CAP=800
GO_TEST_CAP=1500
SWIFT_CAP=600

# Returns 0 if the path is on the allowlist (an entry like "  - <path>").
is_allowlisted() {
  local path="$1"
  [ -f "$ALLOWLIST" ] || return 1
  grep -E "^[[:space:]]*-[[:space:]]*$path([[:space:]]|:|$)" "$ALLOWLIST" >/dev/null 2>&1
}

# Returns 0 if the file has the exception annotation on line 1.
has_exception() {
  local path="$1"
  head -n 1 "$path" 2>/dev/null | grep -q "@file-size-exception:" && return 0
  return 1
}

# Drop paths git ignores.
#
# The `find` prunes below name specific build directories, which is a list
# that cannot keep up: `server/web/` (the browser Studio bundle) is
# gitignored build output whose minified chunks are thousands of lines, so
# any contributor who had run `npm run build:web` failed this gate on files
# that are not source and are never committed. Anything git ignores is by
# definition not part of the repository, so it is not this gate's business.
#
# One `git check-ignore` invocation for the whole list, not one per file.
# Falls through unchanged outside a git work tree so the script still runs
# from an exported tarball.
not_ignored() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    cat
    return
  fi
  git check-ignore --stdin --non-matching --verbose 2>/dev/null \
    | awk -F'\t' '$1 == "::" { print $2 }'
}

violations=0

check() {
  local path="$1"
  local cap="$2"
  local lines
  lines=$(wc -l < "$path" | tr -d ' ')
  if [ "$lines" -gt "$cap" ]; then
    if is_allowlisted "$path"; then
      return 0
    fi
    if has_exception "$path"; then
      return 0
    fi
    echo "FAIL: $path:$lines exceeds cap $cap. Split or add @file-size-exception annotation." >&2
    violations=$((violations + 1))
  fi
}

# TypeScript / TSX / JS (excluding generated/vendor)
while IFS= read -r f; do check "$f" "$TS_CAP"; done < <(
  find . \
    -type d \( \
      -name node_modules -o -name dist -o -name out -o -name release -o -name build \
      -o -name .git -o -name DerivedData -o -name resources -o -name .temp \
    \) -prune -false \
    -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
    ! -name '*.d.ts' \
    ! -path '*/dist/*' ! -path '*/node_modules/*' ! -path '*/release/*' ! -path '*/.temp/*' \
    ! -name 'index-*.js' \
    -print | not_ignored
)

# Go (excluding _test.go)
while IFS= read -r f; do check "$f" "$GO_CAP"; done < <(
  find . \
    -type d \( -name node_modules -o -name dist -o -name out -o -name .git -o -name vendor \) -prune -false \
    -o -type f -name '*.go' ! -name '*_test.go' -print | not_ignored
)

# Go tests
while IFS= read -r f; do check "$f" "$GO_TEST_CAP"; done < <(
  find . \
    -type d \( -name node_modules -o -name dist -o -name out -o -name .git -o -name vendor \) -prune -false \
    -o -type f -name '*_test.go' -print | not_ignored
)

# Swift
while IFS= read -r f; do check "$f" "$SWIFT_CAP"; done < <(
  find . \
    -type d \( -name DerivedData -o -name build -o -name node_modules -o -name .git \) -prune -false \
    -o -type f -name '*.swift' -print | not_ignored
)

if [ "$violations" -gt 0 ]; then
  echo
  echo "$violations file(s) exceeded the file-size cap." >&2
  echo "See docs/architecture/file-organization.md for cap rationale and override mechanics." >&2
  exit 1
fi

echo "file-size check: OK"
