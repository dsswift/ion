#!/usr/bin/env bash
# package-studio-server.sh -- build the Ion Studio Server bundle for one platform.
#
# The bundle is what `install-studio-server.sh` extracts on a host and what
# `ion studio update` downloads later: everything an Environment needs, in one
# tarball, with no build step and no package manager on the host.
#
#   ion-studio-server/
#     VERSION                  {"server":..,"engine":..,"node":..}
#     compat.json              the server's Format Versions ({"formats":[...]}); the engine's come from `bin/ion version --json`
#     bin/ion                  engine binary for the target platform
#     node/bin/node            official Node runtime (SHASUMS256-verified)
#     server/dist/*.js         main.js, pair.js, compat.js, clients.js, hub.js
#     server/resources/        server runtime assets
#     server/package.json      the workspace member (node resolves node_modules by walking up)
#     node_modules/            production dependencies of @ion/server
#     packages/                @ion/shared and the other workspace packages the bundle imports
#
# usage: scripts/package-studio-server.sh <goos> <goarch> <out-dir>
#   goos: darwin|linux   goarch: amd64|arm64
#
# environment:
#   ION_ENGINE_BIN        Prebuilt engine binary to ship (CI: the signed release asset).
#                         Absent: cross-compiled from this checkout.
#   ION_NODE_VERSION      Node runtime to bundle (default: v22.23.2).
#   ION_NODE_CACHE_DIR    Where node tarballs are cached between runs (default: build/node-cache).
#   ION_SKIP_SERVER_BUILD Set to 1 to reuse server/dist as-is.
#   ION_BUILD_COMMIT      The commit the engine's version names, for a tree shipped without
#   ION_BUILD_DIRTY       its git history (an ion fleet builder host); DIRTY is 1 when the
#                         shipped tree had uncommitted changes. Absent: read from git.
#
# node-pty is the bundle's one native module. Its npm tarball ships prebuilt
# binaries for macOS and Windows only; Linux is compiled by node-gyp at
# install time. So a Linux bundle must be packaged on a Linux host of the
# same architecture (CI does), while macOS bundles for either arch can be
# packaged from any Mac. The script refuses the combinations that would
# ship a bundle with no working terminal rather than produce one silently.
set -euo pipefail

GOOS="${1:-}"; GOARCH="${2:-}"; OUT_DIR="${3:-}"
[ -n "$GOOS" ] && [ -n "$GOARCH" ] && [ -n "$OUT_DIR" ] || { sed -n '/^# usage:/,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }
case "$GOOS" in darwin|linux) ;; *) echo "package: goos must be darwin or linux (windows has no service story yet)" >&2; exit 2 ;; esac
case "$GOARCH" in amd64|arm64) ;; *) echo "package: goarch must be amd64 or arm64" >&2; exit 2 ;; esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The tarball is written from inside the work dir, so the out dir must be
# absolute before the cd.
mkdir -p "$OUT_DIR"; OUT_DIR="$(cd "$OUT_DIR" && pwd)"
cd "$REPO_ROOT"
NODE_VERSION="${ION_NODE_VERSION:-v22.23.2}"
NODE_CACHE="${ION_NODE_CACHE_DIR:-$REPO_ROOT/build/node-cache}"
case "$GOARCH" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; esac
NODE_OS="$GOOS"
NODE_TAR="node-$NODE_VERSION-$NODE_OS-$NODE_ARCH.tar.gz"
SERVER_VERSION="$(tr -d '[:space:]' < server/VERSION)"
ENGINE_VERSION="$(tr -d '[:space:]' < engine/VERSION)"
ASSET="ion-studio-server-$GOOS-$GOARCH.tar.gz"

step() { printf '\n==> %s\n' "$*"; }
die() { echo "package: $*" >&2; exit 1; }

HOST_GOOS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in x86_64|amd64) HOST_GOARCH=amd64 ;; arm64|aarch64) HOST_GOARCH=arm64 ;; *) HOST_GOARCH=other ;; esac

WORK="$(mktemp -d -t ion-studio-server.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
BUNDLE="$WORK/ion-studio-server"
mkdir -p "$BUNDLE/bin" "$BUNDLE/server" "$OUT_DIR" "$NODE_CACHE"

# ---------------------------------------------------------------- engine
step "engine $ENGINE_VERSION for $GOOS/$GOARCH"
if [ -n "${ION_ENGINE_BIN:-}" ]; then
  [ -x "$ION_ENGINE_BIN" ] || die "ION_ENGINE_BIN is not an executable: $ION_ENGINE_BIN"
  cp "$ION_ENGINE_BIN" "$BUNDLE/bin/ion"
  echo "using prebuilt engine $ION_ENGINE_BIN"
else
  # CGO on for darwin (Local Network warmup probe and FSEvents watcher,
  # engine/Makefile), off for linux so the binary is static. A darwin/amd64
  # build from an arm64 Mac works because clang can emit x86_64 natively; a
  # linux build from a Mac is a plain static cross-compile.
  CGO=0; [ "$GOOS" = darwin ] && CGO=1
  if [ -n "${ION_BUILD_COMMIT:-}" ]; then
    BUILD_VERSION="$ENGINE_VERSION+$ION_BUILD_COMMIT$([ "${ION_BUILD_DIRTY:-0}" = 1 ] && echo '.dirty')"
  else
    BUILD_VERSION="$ENGINE_VERSION+$(git rev-parse --short HEAD)$(git diff --quiet || echo '.dirty')"
  fi
  (cd engine && CGO_ENABLED=$CGO GOOS=$GOOS GOARCH=$GOARCH go build -ldflags "-s -w -X main.version=$BUILD_VERSION" -o "$BUNDLE/bin/ion" ./cmd/ion/)
  ENGINE_VERSION="$BUILD_VERSION"
  echo "built engine $ENGINE_VERSION"
fi
chmod 755 "$BUNDLE/bin/ion"

# ---------------------------------------------------------------- server bundle
if [ "${ION_SKIP_SERVER_BUILD:-0}" != 1 ]; then
  step "server bundle (esbuild)"
  npm -w server run build >/dev/null
fi
for f in main.js pair.js compat.js clients.js hub.js; do
  [ -f "server/dist/$f" ] || die "server/dist/$f is missing (run without ION_SKIP_SERVER_BUILD)"
done

step "stage @ion/server workspace"
# The npm workspace needs every member's package.json to satisfy the
# lockfile (desktop's is copied for that reason only; its sources never
# ship). `npm ci -w server` then installs only what @ion/server and
# @ion/shared need.
STAGE="$WORK/stage"
mkdir -p "$STAGE/server" "$STAGE/desktop"
cp package-lock.json "$STAGE/"
# The root package.json's lifecycle scripts (husky `prepare`, the
# spawn-helper `postinstall`) belong to a dev checkout, not a stage with no
# git repo and no scripts/; strip them so `npm ci` installs and nothing
# else. The spawn-helper bit is set explicitly below.
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
delete pkg.scripts;
fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2) + "\n");
' "$STAGE/package.json"
cp desktop/package.json "$STAGE/desktop/"
cp server/package.json server/VERSION "$STAGE/server/"
rsync -a --exclude node_modules --exclude '__tests__' --exclude '*.test.ts' packages/ "$STAGE/packages/"
rsync -a server/dist/ "$STAGE/server/dist/"
rsync -a server/resources/ "$STAGE/server/resources/"

step "production dependencies ($GOOS/$GOARCH)"
NODE_PTY_PLATFORM="$GOOS-$NODE_ARCH"
if [ "$HOST_GOOS" = "$GOOS" ] && [ "$HOST_GOARCH" = "$GOARCH" ]; then
  # Same platform: let node-pty's install script run, so Linux compiles its
  # binding and macOS keeps its prebuild. The helper bit is set below as
  # well, so a cross-platform `--ignore-scripts` install ends up identical.
  (cd "$STAGE" && npm ci -w server --omit=dev --no-audit --no-fund >/dev/null 2>"$WORK/npm.err") || { cat "$WORK/npm.err" >&2; die "npm ci failed"; }
else
  (cd "$STAGE" && npm ci -w server --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>"$WORK/npm.err") || { cat "$WORK/npm.err" >&2; die "npm ci failed"; }
  [ -d "$STAGE/node_modules/node-pty/prebuilds/$NODE_PTY_PLATFORM" ] \
    || die "node-pty ships no prebuild for $NODE_PTY_PLATFORM; package a $GOOS/$GOARCH bundle on a $GOOS/$GOARCH host (CI does)"
fi
if [ "$GOOS" = linux ] && [ "$HOST_GOOS" = "$GOOS" ] && [ "$HOST_GOARCH" = "$GOARCH" ]; then
  [ -f "$STAGE/node_modules/node-pty/build/Release/pty.node" ] || die "node-pty did not build its Linux binding (python3, make, g++ present?)"
fi
# npm extracts spawn-helper 0644; a non-executable helper makes every
# terminal fail with "posix_spawnp failed." (scripts/node-pty-spawn-helper.js).
for helper in "$STAGE"/node_modules/node-pty/prebuilds/*/spawn-helper; do
  [ -f "$helper" ] && chmod 755 "$helper"
done
rsync -a "$STAGE/node_modules/" "$BUNDLE/node_modules/"
rsync -a "$STAGE/packages/" "$BUNDLE/packages/"
rsync -a "$STAGE/server/" "$BUNDLE/server/"
cp "$STAGE/package.json" "$BUNDLE/package.json"

# ---------------------------------------------------------------- node runtime
step "node runtime $NODE_VERSION ($NODE_OS-$NODE_ARCH)"
if [ ! -f "$NODE_CACHE/$NODE_TAR" ]; then
  echo "downloading $NODE_TAR"
  curl -fsSL -o "$NODE_CACHE/$NODE_TAR.partial" "https://nodejs.org/dist/$NODE_VERSION/$NODE_TAR"
  curl -fsSL -o "$NODE_CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  mv "$NODE_CACHE/$NODE_TAR.partial" "$NODE_CACHE/$NODE_TAR"
fi
[ -f "$NODE_CACHE/SHASUMS256-$NODE_VERSION.txt" ] || curl -fsSL -o "$NODE_CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
(cd "$NODE_CACHE" && grep " $NODE_TAR\$" "SHASUMS256-$NODE_VERSION.txt" | shasum -a 256 -c - >/dev/null) || die "node tarball checksum mismatch for $NODE_TAR"
mkdir -p "$BUNDLE/node"
tar -xzf "$NODE_CACHE/$NODE_TAR" -C "$BUNDLE/node" --strip-components=1
# Only the runtime ships: npm and its docs are half the tarball and the
# bundle never runs a package manager.
rm -rf "$BUNDLE/node/lib/node_modules" "$BUNDLE/node/bin/npm" "$BUNDLE/node/bin/npx" "$BUNDLE/node/bin/corepack" "$BUNDLE/node/share" "$BUNDLE/node/include" "$BUNDLE/node/CHANGELOG.md" "$BUNDLE/node/README.md"

# ---------------------------------------------------------------- manifest + tarball
printf '{"server":"%s","engine":"%s","node":"%s"}\n' "$SERVER_VERSION" "$ENGINE_VERSION" "$NODE_VERSION" > "$BUNDLE/VERSION"
# The registry is the same on every platform, so the packaging host's node
# prints it; the target's node may not run here.
node server/dist/compat.js > "$BUNDLE/compat.json" || die "could not write compat.json"

step "verify tree"
for p in bin/ion node/bin/node server/dist/main.js server/dist/pair.js server/dist/clients.js server/package.json node_modules/node-pty/package.json packages/shared/package.json VERSION; do
  [ -e "$BUNDLE/$p" ] || die "bundle is missing $p"
done
for helper in "$BUNDLE"/node_modules/node-pty/prebuilds/*/spawn-helper; do
  [ ! -f "$helper" ] || [ -x "$helper" ] || die "spawn-helper is not executable: $helper"
done
if [ "$HOST_GOOS" = "$GOOS" ] && [ "$HOST_GOARCH" = "$GOARCH" ]; then
  "$BUNDLE/node/bin/node" -v | grep -qx "$NODE_VERSION" || die "bundled node does not run"
  "$BUNDLE/bin/ion" version >/dev/null || die "bundled engine does not run"
fi

step "tar $ASSET"
(cd "$WORK" && tar -czf "$OUT_DIR/$ASSET" ion-studio-server)
ls -la "$OUT_DIR/$ASSET"
echo "$OUT_DIR/$ASSET"
