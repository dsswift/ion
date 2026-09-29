#!/usr/bin/env bash
# Proves a packaged Studio server bundle is complete: the expected tree, an
# executable node-pty spawn-helper, a VERSION manifest naming every part, and
# (on the packaging host's own platform) a runtime that starts and an engine
# that answers `version`.
#
# This is the artifact check the release job runs before uploading, and the
# one to run by hand after touching package-studio-server.sh. It downloads
# the Node runtime once into build/node-cache and builds the engine, so it is
# a minute of work rather than a unit test; it is not part of the dev-loop
# gates.
#
# usage: scripts/package-studio-server.test.sh [<path to an existing bundle tarball>]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d -t package-studio-server-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

HOST_GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in x86_64|amd64) HOST_GOARCH=amd64 ;; arm64|aarch64) HOST_GOARCH=arm64 ;; *) fail "unsupported host arch" ;; esac

# A tarball built here is versioned the way an ion fleet builder host
# versions one, from ION_BUILD_COMMIT/ION_BUILD_DIRTY instead of git.
BUILT_HERE=0
if [ -n "${1:-}" ]; then
  TARBALL="$1"
else
  BUILT_HERE=1
  TARBALL="$(ION_BUILD_COMMIT=fleet0001 ION_BUILD_DIRTY=1 bash "$REPO_ROOT/scripts/package-studio-server.sh" "$HOST_GOOS" "$HOST_GOARCH" "$TMP/out" | tail -n 1)"
fi
[ -f "$TARBALL" ] || fail "no tarball at $TARBALL"

mkdir -p "$TMP/x"
tar -xzf "$TARBALL" -C "$TMP/x"
B="$TMP/x/ion-studio-server"
[ -d "$B" ] || fail "tarball must extract to ion-studio-server/"

for p in VERSION compat.json bin/ion node/bin/node server/dist/main.js server/dist/pair.js server/dist/compat.js server/dist/clients.js server/package.json package.json node_modules/node-pty/package.json node_modules/ws/package.json packages/shared/package.json; do
  [ -e "$B/$p" ] || fail "bundle is missing $p"
done
[ ! -e "$B/node/bin/npm" ] || fail "npm must be stripped from the runtime"
[ ! -d "$B/node_modules/typescript" ] || fail "devDependencies must not ship"

for k in server engine node; do
  grep -q "\"$k\":\"[^\"]\+\"" "$B/VERSION" || fail "VERSION lacks $k: $(cat "$B/VERSION")"
done

grep -q '"id": "transfer-archive"' "$B/compat.json" || fail "compat.json lacks the transfer archive format: $(cat "$B/compat.json")"

helpers=0
for h in "$B"/node_modules/node-pty/prebuilds/*/spawn-helper; do
  [ -f "$h" ] || continue
  helpers=$((helpers + 1))
  [ -x "$h" ] || fail "spawn-helper is not executable: $h"
done
if [ "$HOST_GOOS" = darwin ]; then [ "$helpers" -gt 0 ] || fail "no darwin spawn-helper found"; fi
if [ "$HOST_GOOS" = linux ]; then [ -f "$B/node_modules/node-pty/build/Release/pty.node" ] || fail "linux node-pty binding missing"; fi

case "$TARBALL" in
  *"-$HOST_GOOS-$HOST_GOARCH.tar.gz")
    "$B/node/bin/node" -v >/dev/null || fail "bundled node does not run"
    "$B/bin/ion" version | grep -q ion-engine || fail "bundled engine does not answer version"
    if [ "$BUILT_HERE" = 1 ]; then
      "$B/bin/ion" version | grep -q '+fleet0001.dirty' || fail "the engine must take its commit from ION_BUILD_COMMIT/ION_BUILD_DIRTY: $("$B/bin/ion" version)"
    fi
    # The one thing the tree check cannot prove: the server's module graph
    # resolves from inside the bundle and a pty actually spawns.
    (cd "$B/server" && "$B/node/bin/node" -e "const pty=require('node-pty'); const p=pty.spawn('/bin/sh',['-c','echo PTY_OK'],{cwd:process.env.HOME}); let out=''; p.onData(d=>{out+=d}); p.onExit(({exitCode})=>{ if(!out.includes('PTY_OK')||exitCode!==0){console.error('node-pty spawn probe failed',{exitCode,out}); process.exit(1)} })") || fail "node-pty spawn probe failed inside the bundle"
    # pair.js prints its usage and exits 2 on --help. Invoked THROUGH a
    # symlink on purpose: the installed layout runs every entry via
    # `current -> versions/<v>`, and the entry guard once compared paths
    # byte-for-byte and silently skipped main() (server/src/entry-guard.ts).
    ln -sfn "$B" "$TMP/current"
    { "$TMP/current/node/bin/node" "$TMP/current/server/dist/pair.js" --help 2>&1 || true; } | grep -q usage || fail "pair.js does not run its main() through a symlinked path"
    ;;
esac

echo "package-studio-server.test.sh: OK ($TARBALL)"
