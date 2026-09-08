#!/usr/bin/env bash
# Fail when a compiled executable is tracked in git.
#
# Build output is gitignored, but an ignore only helps for paths someone
# thought of in advance. A `git add -A` from a directory holding a fresh
# `go build` will happily commit a 30MB binary under a name no rule covers,
# and nothing in review reliably catches it: the diff renders as "Bin 0 ->
# 33644032 bytes" and scrolls past.
#
# This checks what is actually tracked, so it catches the file regardless of
# what it is called.
set -euo pipefail

fail=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$(file -b --mime-type "$f")" in
    application/x-mach-binary | application/x-executable | application/x-dosexec | \
      application/x-sharedlib | application/vnd.microsoft.portable-executable)
      echo "  tracked binary: $f"
      fail=1
      ;;
  esac
done < <(git ls-files)

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "check-no-binaries: FAILED — compiled executables must not be committed."
  echo "  Remove with: git rm --cached <path>, then add it to .gitignore."
  exit 1
fi

echo "check-no-binaries: OK"
