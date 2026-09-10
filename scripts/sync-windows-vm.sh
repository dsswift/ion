#!/usr/bin/env bash
# Sync this checkout's tracked source to a Windows test VM.
#
# Why this exists as a script and not a note in a doc.
#
# Windows-specific defects are only observable on Windows, so the loop is:
# change source here, sync, build there, install, have the operator's agent
# retest. Twice in one session that loop produced a false negative because the
# sync step was skipped or partial — a fix was committed and verified on macOS,
# the VM was never updated, and the retest measured the previous binary and
# reported the bug unfixed. The second time also revealed the VM's tree had
# been drifting for longer: a per-file scp habit had left it missing a file
# that predated the branch entirely.
#
# A hand-picked file list cannot be trusted for this. `git diff` names only
# what the current branch touched, which silently omits anything the VM missed
# earlier. So this ships every tracked file under the synced roots, as one
# archive, every time — a few seconds of transfer in exchange for removing the
# whole class of failure.
#
# Untracked files are deliberately NOT sent. A build artifact, a local probe,
# or an experiment that only exists here has no business on the machine under
# test; the VM should build from what is committed.
set -euo pipefail

VM_HOST="${ION_WIN_VM_HOST:-josh@10.211.55.3}"
VM_PATH="${ION_WIN_VM_PATH:-C:/dev/ion}"

# Roots that affect a Windows build. desktop/ carries the Electron app and the
# installer config; engine/ is the Go binary; packaging/ and scripts/ hold the
# NSIS script and the PowerShell build harness.
#
# The root files are named individually because the VM builds by running
# make.ps1, and make.ps1 was never synced -- it arrived on the VM by hand once
# and then drifted, which is the exact per-file failure mode this script exists
# to remove. release-please-manifest.json is here because the desktop version
# resolver reads it.
ROOTS=(engine desktop packaging scripts Makefile make.ps1 bootstrap.ps1 release-please-manifest.json)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! command -v ssh >/dev/null 2>&1; then
  echo "sync-windows-vm: ssh not found" >&2
  exit 1
fi

echo "sync-windows-vm: target ${VM_HOST}:${VM_PATH}"

# Fail loudly and early when the VM is not reachable. A silent failure here is
# what produces a retest against a stale binary.
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$VM_HOST" 'exit' 2>/dev/null; then
  echo "sync-windows-vm: cannot reach ${VM_HOST}" >&2
  echo "  Is the VM running? Set ION_WIN_VM_HOST to override the address." >&2
  exit 1
fi

list="$(mktemp)"
stamp_dir="$(mktemp -d -t ion-sync-stamp-XXXXXX)"
archive="$(mktemp -t ion-sync-XXXXXX).tar"
trap 'rm -f "$list" "$archive" "$archive.gz"; rm -rf "$stamp_dir"' EXIT

# Tracked files only, under the roots that matter to a Windows build.
git ls-files -- "${ROOTS[@]}" > "$list"
file_count="$(wc -l < "$list" | tr -d ' ')"
if [ "$file_count" -eq 0 ]; then
  echo "sync-windows-vm: no tracked files matched; refusing to sync nothing" >&2
  exit 1
fi

# Resolve the stamp BEFORE the archive is built, because the stamp travels
# inside it.
#
# The VM has no .git -- it receives a tar of tracked files -- so nothing over
# there can resolve a version. desktop/scripts/desktop-version.js needs git
# history to compute one, and without this it simply throws on the VM.
#
# So the machine that HAS the history answers, once, here, and the answer
# travels with the files. Resolve-IonDesktopVersion (scripts/windows/IonBuild.ps1)
# reads it back when it finds no git repository, which is what lets a VM build
# stamp a version that means something instead of falling back to the stale
# number in desktop/package.json.
head_sha_full="$(git rev-parse HEAD)"
head_sha="$(git rev-parse --short HEAD)"
head_subject="$(git log -1 --pretty=%s)"

# Which tracked files are modified, not merely whether any are. A VM build
# that is not reproducible from its commit has to be able to say which edits
# it carried, and "dirty=true" alone cannot.
dirty_files=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  dirty_files="${dirty_files}${line}
"
done < <(git status --porcelain --untracked-files=no | cut -c4-)
dirty_count="$(printf '%s' "$dirty_files" | grep -c . || true)"
dirty=false
if [ "$dirty_count" -gt 0 ]; then dirty=true; fi

desktop_version=""
if command -v node >/dev/null 2>&1; then
  desktop_version="$(node desktop/scripts/desktop-version.js)"
fi
if [ -z "$desktop_version" ]; then
  echo "sync-windows-vm: could not resolve the desktop version (is node installed?)" >&2
  echo "  The VM build would then have no version to stamp. Refusing to sync a tree it cannot version." >&2
  exit 1
fi

# The dirty file list as a JSON array, built here rather than by a helper so
# the sync keeps its only hard dependencies as git, tar, ssh and node. git
# already C-escapes a path containing anything exotic, so escaping the two
# characters JSON cares about is sufficient for what git hands us.
dirty_json='[]'
if [ "$dirty_count" -gt 0 ]; then
  dirty_json='['
  sep=''
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    esc="${f//\\/\\\\}"
    esc="${esc//\"/\\\"}"
    dirty_json="${dirty_json}${sep}\"${esc}\""
    sep=', '
  done <<< "$dirty_files"
  dirty_json="${dirty_json}]"
fi

cat > "$stamp_dir/.ion-sync-stamp.json" <<STAMP
{
  "commit": "${head_sha_full}",
  "dirty": ${dirty},
  "dirtyFiles": ${dirty_json},
  "desktopVersion": "${desktop_version}",
  "syncedAtUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STAMP

# ONE archive, carrying the source AND the stamp that describes it.
#
# These were two transfers once: an scp of the source archive, then a second
# scp of the stamp. A failure between them left the VM holding NEW source
# under the PREVIOUS stamp, so a build would report a version and a commit
# that did not describe the tree it built -- the exact class of false
# provenance the stamp exists to remove. Now the stamp is a member of the
# archive: it lands when the source lands, or neither does.
#
# Two tar invocations, one archive: bsdtar parses every -C before it reads
# the -T list, so a single command cannot mix repo-relative entries with a
# file from elsewhere. Create, append the stamp, then compress.
tar cf "$archive" -T "$list"
tar rf "$archive" -C "$stamp_dir" .ion-sync-stamp.json
gzip -n -f "$archive"
archive="$archive.gz"
size="$(wc -c < "$archive" | tr -d ' ')"
echo "sync-windows-vm: ${file_count} files + sync stamp, ${size} bytes"

# tar over ssh, extracted in place. Extraction overwrites and adds; it does not
# delete, so a file removed from git stays on the VM until someone clears the
# tree. That is the accepted trade: a stale extra file cannot make a build
# report a false pass, while a missing file demonstrably can.
scp -q "$archive" "${VM_HOST}:C:/Users/josh/ion-sync.tgz"
ssh "$VM_HOST" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path '${VM_PATH}' | Out-Null; Set-Location '${VM_PATH}'; tar xzf C:/Users/josh/ion-sync.tgz; Remove-Item C:/Users/josh/ion-sync.tgz\""

echo "sync-windows-vm: stamped desktop version ${desktop_version} (dirty=${dirty})"

# Report the commit the VM now holds, so a build log can be tied back to a
# known revision rather than "whatever was there".
echo "sync-windows-vm: VM now holds ${head_sha} (${head_subject})"

if [ "$dirty" = true ]; then
  echo "sync-windows-vm: NOTE ${dirty_count} tracked file(s) are modified but uncommitted;"
  echo "  the VM has your working-tree contents, not ${head_sha} exactly."
  echo "  The sync stamp names them, so the VM build's provenance does too:"
  while IFS= read -r f; do [ -n "$f" ] && echo "    $f"; done <<< "$dirty_files"
fi
