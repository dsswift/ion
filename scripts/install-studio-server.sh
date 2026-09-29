#!/bin/sh
# install-studio-server.sh -- install the Ion Studio Server (engine + server)
# on this host as a background service.
#
#   curl -fsSL https://github.com/dsswift/ion/releases/latest/download/install-studio-server.sh | sh
#
# Downloads the release bundle for this platform, verifies it against the
# release's checksums.txt, extracts it to ~/.ion/studio-server/versions/<v>,
# points ~/.ion/studio-server/current at it, and runs
# `ion studio install`, which writes a default server.json, installs the
# services (launchd on macOS, systemd on Linux), and waits for the server to
# answer. Re-running is safe: an already-installed version is reused and the
# services are (re)started against it.
#
# environment:
#   ION_STUDIO_VERSION     Server version to install (default: latest release).
#   ION_RELEASE_BASE_URL   Where releases live (default: https://github.com/dsswift/ion/releases).
#   ION_STUDIO_BUNDLE      Path to a local bundle tarball; skips the download and
#                          the checksum (a dev build, or the desktop's SSH door).
#   ION_DATA_DIR           Data directory for both services (default: ~/.ion).
#   ION_STUDIO_INSTALL_ARGS  Extra flags for `ion studio install` (e.g. "--system --label lab").
#
# The last line on stdout is a JSON receipt, {"ok":true,...}, from
# `ion studio install`; the desktop's SSH door reads that line.
set -eu

say() { printf '==> %s\n' "$*"; }
die() { printf 'install-studio-server: %s\n' "$*" >&2; exit 1; }

REPO="dsswift/ion"
BASE_URL="${ION_RELEASE_BASE_URL:-https://github.com/$REPO/releases}"
BASE_URL="${BASE_URL%/}"
DATA_DIR="${ION_DATA_DIR:-$HOME/.ion}"
ROOT="$DATA_DIR/studio-server"

case "$(uname -s)" in
  Darwin) GOOS=darwin ;;
  Linux) GOOS=linux ;;
  *) die "unsupported OS $(uname -s): the Studio server runs as a service on macOS and Linux only" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) GOARCH=amd64 ;;
  arm64|aarch64) GOARCH=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
ASSET="ion-studio-server-$GOOS-$GOARCH.tar.gz"

fetch() {
  # $1 url, $2 dest, $3 what it is (for the failure message)
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 30 -o "$2" "$1" || die "could not download $3 from $1 (curl exit $?)"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "could not download $3 from $1 (wget exit $?)"
  else die "curl or wget is required to download $1"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum or shasum is required to verify the download"; fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ion-studio-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------------------------------------------------------------- obtain the bundle
if [ -n "${ION_STUDIO_BUNDLE:-}" ]; then
  [ -f "$ION_STUDIO_BUNDLE" ] || die "ION_STUDIO_BUNDLE does not exist: $ION_STUDIO_BUNDLE"
  say "using local bundle $ION_STUDIO_BUNDLE"
  TARBALL="$ION_STUDIO_BUNDLE"
else
  if [ -n "${ION_STUDIO_VERSION:-}" ]; then
    VERSION="${ION_STUDIO_VERSION#v}"
    RELEASE_URL="$BASE_URL/download/server-v$VERSION"
  else
    # `releases/latest` resolves to the newest release of ANY component in
    # this repository, so ask the API for the newest server-v tag instead.
    say "resolving the latest Studio server release"
    fetch "https://api.github.com/repos/$REPO/releases?per_page=30" "$WORK/releases.json" "the release list"
    VERSION="$(sed -n 's/^ *"tag_name": *"server-v\([^"]*\)".*/\1/p' "$WORK/releases.json" | head -n 1)"
    [ -n "$VERSION" ] || die "no server-v release found at $BASE_URL"
    RELEASE_URL="$BASE_URL/download/server-v$VERSION"
  fi
  say "downloading $ASSET $VERSION"
  # A pinned version that was never released (a desktop built from source
  # pins the server version it was built with) fails here; say so by name
  # rather than leaving a bare HTTP error.
  fetch "$RELEASE_URL/$ASSET" "$WORK/$ASSET" "Studio server $VERSION for $GOOS/$GOARCH (is release server-v$VERSION published?)"
  fetch "$RELEASE_URL/checksums.txt" "$WORK/checksums.txt" "checksums.txt for server-v$VERSION"
  EXPECTED="$(grep " \(\./\)\{0,1\}$ASSET\$" "$WORK/checksums.txt" | cut -d' ' -f1 | head -n 1)"
  [ -n "$EXPECTED" ] || die "checksums.txt has no entry for $ASSET"
  ACTUAL="$(sha256_of "$WORK/$ASSET")"
  [ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $ASSET: expected $EXPECTED, got $ACTUAL"
  say "checksum verified"
  TARBALL="$WORK/$ASSET"
fi

# ---------------------------------------------------------------- extract
mkdir -p "$WORK/extract"
tar -xzf "$TARBALL" -C "$WORK/extract" --strip-components=1
[ -f "$WORK/extract/VERSION" ] || die "the bundle has no VERSION file; is $TARBALL a Studio server bundle?"
BUNDLE_VERSION="$(sed -n 's/.*"server": *"\([^"]*\)".*/\1/p' "$WORK/extract/VERSION")"
[ -n "$BUNDLE_VERSION" ] || die "the bundle's VERSION file names no server version"
# A dev bundle's server version is the same across rebuilds, so a local
# bundle always replaces its version directory; a release is immutable.
DEST="$ROOT/versions/$BUNDLE_VERSION"
if [ -n "${ION_STUDIO_BUNDLE:-}" ] || [ ! -d "$DEST" ]; then
  say "installing $BUNDLE_VERSION into $DEST"
  mkdir -p "$ROOT/versions"
  rm -rf "$DEST.partial"
  mv "$WORK/extract" "$DEST.partial"
  rm -rf "$DEST"
  mv "$DEST.partial" "$DEST"
else
  say "version $BUNDLE_VERSION is already installed at $DEST"
fi
chmod 755 "$DEST/bin/ion" "$DEST/node/bin/node"
# ln -sfn replaces the symlink itself; `mv` onto a symlink-to-directory
# would move the new link INTO the old target instead.
ln -sfn "$DEST" "$ROOT/current"
say "current -> $DEST"

# ---------------------------------------------------------------- services
say "running ion studio install"
# shellcheck disable=SC2086 # ION_STUDIO_INSTALL_ARGS is a flag list by contract
exec env ION_DATA_DIR="$DATA_DIR" "$ROOT/current/bin/ion" studio install --data-dir "$DATA_DIR" ${ION_STUDIO_INSTALL_ARGS:-}
