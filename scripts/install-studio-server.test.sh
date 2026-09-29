#!/usr/bin/env bash
# Regression coverage for scripts/install-studio-server.sh.
#
# Runs the installer against a fake bundle in a throwaway HOME with a stub
# `ion` that records its argv, so the layout it produces (versions/<v>,
# the `current` symlink, the exec into `ion studio install --data-dir`) is
# pinned without touching the network or a real service manager.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/install-studio-server.sh"
TMP="$(mktemp -d -t install-studio-server-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

make_bundle() {
  # $1 = server version, $2 = tarball path
  local root="$TMP/bundle-src-$1"
  rm -rf "$root"; mkdir -p "$root/ion-studio-server/bin" "$root/ion-studio-server/node/bin" "$root/ion-studio-server/server/dist"
  printf '{"server":"%s","engine":"9.9.9","node":"v22.0.0"}\n' "$1" > "$root/ion-studio-server/VERSION"
  cat > "$root/ion-studio-server/bin/ion" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" > "$ION_DATA_DIR/ion-argv.txt"
printf 'ION_DATA_DIR=%s\n' "$ION_DATA_DIR" > "$ION_DATA_DIR/ion-env.txt"
echo '{"ok":true,"version":"stub"}'
STUB
  printf '#!/bin/sh\necho v22.0.0\n' > "$root/ion-studio-server/node/bin/node"
  : > "$root/ion-studio-server/server/dist/main.js"
  chmod 644 "$root/ion-studio-server/bin/ion" "$root/ion-studio-server/node/bin/node"
  (cd "$root" && tar -czf "$2" ion-studio-server)
}

HOME_DIR="$TMP/home"; mkdir -p "$HOME_DIR"
DATA="$HOME_DIR/.ion"

# --- local bundle install -----------------------------------------------------
make_bundle 0.5.0 "$TMP/b1.tgz"
out="$(HOME="$HOME_DIR" ION_STUDIO_BUNDLE="$TMP/b1.tgz" ION_STUDIO_INSTALL_ARGS="--label lab --system" sh "$SCRIPT")"
echo "$out" | tail -n 1 | grep -q '"ok":true' || fail "last stdout line must be the JSON receipt, got: $(echo "$out" | tail -n 1)"
[ -L "$DATA/studio-server/current" ] || fail "current symlink missing"
[ "$(readlink "$DATA/studio-server/current")" = "$DATA/studio-server/versions/0.5.0" ] || fail "current points at $(readlink "$DATA/studio-server/current")"
[ -x "$DATA/studio-server/versions/0.5.0/bin/ion" ] || fail "bin/ion must be made executable"
[ -x "$DATA/studio-server/versions/0.5.0/node/bin/node" ] || fail "node must be made executable"
grep -q "^studio install --data-dir $DATA --label lab --system$" "$DATA/ion-argv.txt" || fail "ion argv was: $(cat "$DATA/ion-argv.txt")"
grep -q "^ION_DATA_DIR=$DATA$" "$DATA/ion-env.txt" || fail "ION_DATA_DIR not exported to ion"

# --- a second local bundle with the same version replaces it (dev rebuild) ------
make_bundle 0.5.0 "$TMP/b2.tgz"
echo "marker" > "$DATA/studio-server/versions/0.5.0/OLD"
HOME="$HOME_DIR" ION_STUDIO_BUNDLE="$TMP/b2.tgz" sh "$SCRIPT" >/dev/null
[ ! -e "$DATA/studio-server/versions/0.5.0/OLD" ] || fail "a local bundle must replace the same-version directory"

# --- a newer version installs beside the old one and repoints current -----------
make_bundle 0.6.0 "$TMP/b3.tgz"
HOME="$HOME_DIR" ION_STUDIO_BUNDLE="$TMP/b3.tgz" sh "$SCRIPT" >/dev/null
[ -d "$DATA/studio-server/versions/0.5.0" ] || fail "older version must be kept for rollback"
[ "$(readlink "$DATA/studio-server/current")" = "$DATA/studio-server/versions/0.6.0" ] || fail "current must move to 0.6.0"

# --- a pinned version with no release fails by name, not with a bare curl code --
set +e
err="$(HOME="$HOME_DIR" ION_RELEASE_BASE_URL="http://127.0.0.1:1/releases" ION_STUDIO_VERSION="0.0.0-none" sh "$SCRIPT" 2>&1 >/dev/null)"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "a missing release must fail the install"
echo "$err" | grep -q "could not download Studio server 0.0.0-none for" || fail "missing-release message was: $err"
echo "$err" | grep -q "is release server-v0.0.0-none published?" || fail "missing-release message must name the release tag: $err"

# --- ION_DATA_DIR override ------------------------------------------------------
ALT="$TMP/alt-data"
HOME="$HOME_DIR" ION_DATA_DIR="$ALT" ION_STUDIO_BUNDLE="$TMP/b3.tgz" sh "$SCRIPT" >/dev/null
[ -L "$ALT/studio-server/current" ] || fail "ION_DATA_DIR must relocate the bundle root"
grep -q "^studio install --data-dir $ALT$" "$ALT/ion-argv.txt" || fail "data dir flag: $(cat "$ALT/ion-argv.txt")"

# --- a non-bundle tarball is refused --------------------------------------------
mkdir -p "$TMP/junk/ion-studio-server"; : > "$TMP/junk/ion-studio-server/README"
(cd "$TMP/junk" && tar -czf "$TMP/junk.tgz" ion-studio-server)
if HOME="$HOME_DIR" ION_STUDIO_BUNDLE="$TMP/junk.tgz" sh "$SCRIPT" >/dev/null 2>"$TMP/err"; then fail "a tarball without VERSION must be refused"; fi
grep -q "no VERSION file" "$TMP/err" || fail "refusal must name the missing VERSION: $(cat "$TMP/err")"

# --- a missing local bundle path is refused before anything is touched ----------
if HOME="$TMP/home2" ION_STUDIO_BUNDLE="$TMP/nope.tgz" sh "$SCRIPT" >/dev/null 2>"$TMP/err2"; then fail "a missing bundle must be refused"; fi
[ ! -d "$TMP/home2/.ion" ] || fail "nothing may be created when the bundle is missing"

echo "install-studio-server.test.sh: OK"
