#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ION_HOME="$HOME/.ion"
BIN_DIR="$ION_HOME/bin"
PLIST_LABEL="com.ion.engine"
PLIST_FILENAME="com.ion.engine.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

cd "$SCRIPT_DIR"

# ── Preflight ──
#
# Checks Go version and Xcode CLT before attempting the build. Catches the
# most common first-run failure modes with actionable messages.
preflight_check() {
  local fail=0
  local required_go
  required_go=$(awk '/^go / {print $2}' go.mod 2>/dev/null || echo "")

  echo "==> Checking build dependencies..."

  # Go — version must meet or exceed go.mod's `go` directive.
  if command -v go >/dev/null 2>&1; then
    local installed_go
    installed_go=$(go version | awk '{print $3}' | sed 's/^go//')
    if [[ -n "$required_go" ]]; then
      # Simple lexicographic comparison works for semver with equal depth.
      if [[ "$(printf '%s\n%s' "$installed_go" "$required_go" | sort -V | head -1)" == "$required_go" ]]; then
        echo "  ✓ Go $installed_go (≥ $required_go required)"
      else
        echo "  ✗ Go $installed_go is too old. go.mod requires ≥ $required_go."
        echo "    Update: brew install go  or  https://go.dev/dl/"
        fail=1
      fi
    else
      echo "  ✓ Go $installed_go"
    fi
  else
    local req="${required_go:-1.21}"
    echo "  ✗ Go is not installed (go.mod requires ≥ $req)."
    echo "    Install: brew install go  or  https://go.dev/dl/"
    fail=1
  fi

  # Xcode CLT — needed for CGO (cgo calls into macOS system libraries).
  if xcode-select -p >/dev/null 2>&1; then
    echo "  ✓ Xcode toolchain at $(xcode-select -p)"
  else
    echo "  ✗ Xcode Command Line Tools not installed."
    echo "    Install: xcode-select --install"
    fail=1
  fi

  if [[ $fail -ne 0 ]]; then
    echo
    echo "✗ Preflight failed. Fix the issues above and retry."
    exit 1
  fi

  echo
}

preflight_check

echo "==> Building Ion Engine..."
go build -o bin/ion ./cmd/ion

echo "==> Installing to $BIN_DIR..."
mkdir -p "$BIN_DIR"

# Stop the running LaunchAgent so the new binary takes effect on next start.
# bootout removes the service from the bootstrap namespace (prevents KeepAlive
# restart). On a fresh install (no agent ever loaded) bootout exits non-zero.
echo "==> Stopping engine LaunchAgent (if running)..."
launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
# Wait for the service to be fully removed from the namespace. Without this,
# bootstrap can see the departing service as "already loaded" (exit 5) and
# RunAtLoad won't fire — leaving the old binary running.
for _i in $(seq 1 50); do
    launchctl print "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1 || break
    sleep 0.1
done
rm -f "$ION_HOME/engine.sock"

rm -f "$BIN_DIR/ion"
cp bin/ion "$BIN_DIR/ion"
chmod +x "$BIN_DIR/ion"

# Sign with a stable identity so macOS treats every rebuild as the same app.
# Ad-hoc signing derives the identifier from the binary's CDHash ("ion-<hash>"),
# which changes on every build — macOS Local Network privacy keys its grant to
# that identity, so each ad-hoc rebuild silently resets the grant and the
# headless LaunchAgent gets EHOSTUNREACH ("no route to host") on LAN targets
# with no prompt. A certificate-backed signature with an explicit identifier
# keeps a stable designated requirement, so the grant survives rebuilds.
#
# The identifier is deliberately namespaced ("house.sprague.ion.engine", not
# "ion"): Local Network grant creation is silently suppressed for an identity
# that already has records in the (SIP-locked, uneditable) NetworkExtension
# policy store, and the bare "ion" identifier accumulated dozens of stale
# ad-hoc records before this script signed stably. A namespaced identifier
# with no prior records gets a real grant from the engine's startup warmup
# probe (internal/network/lanwarmup_darwin.go). Keep it in sync with
# desktop/scripts/afterPack.js and the release workflow.
#
# Identity precedence mirrors desktop/scripts/afterPack.js:
# APPLE_SIGNING_IDENTITY env, then the "Ion Local Dev" self-signed cert, then
# ad-hoc as a last resort.
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-Ion Local Dev}"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$SIGN_IDENTITY"; then
    echo "==> Signing engine binary (identity: $SIGN_IDENTITY)..."
    codesign --force --sign "$SIGN_IDENTITY" --identifier house.sprague.ion.engine --options runtime "$BIN_DIR/ion" \
        || codesign --force --sign - "$BIN_DIR/ion" 2>/dev/null || true
else
    echo "==> Signing engine binary (ad-hoc — identity \"$SIGN_IDENTITY\" not in keychain)..."
    codesign --force --sign - "$BIN_DIR/ion" 2>/dev/null || true
fi
xattr -cr "$BIN_DIR/ion" 2>/dev/null || true

if [[ "${1:-}" == "--standalone" ]]; then
    # Add to PATH if not already there
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
        SHELL_RC=""
        if [[ -f "$HOME/.zshrc" ]]; then
            SHELL_RC="$HOME/.zshrc"
        elif [[ -f "$HOME/.bashrc" ]]; then
            SHELL_RC="$HOME/.bashrc"
        fi

        if [[ -n "$SHELL_RC" ]]; then
            if ! grep -q "\.ion/bin" "$SHELL_RC"; then
                echo "" >> "$SHELL_RC"
                echo '# Ion Engine' >> "$SHELL_RC"
                echo 'export PATH="$HOME/.ion/bin:$PATH"' >> "$SHELL_RC"
                echo "  Added $BIN_DIR to PATH in $SHELL_RC"
                echo "  Run: source $SHELL_RC"
            fi
        fi
    fi
fi

# Install LaunchAgent plist from the repo template, substituting $HOME.
# Written/refreshed on every install so updates propagate.
PLIST_TEMPLATE="$SCRIPT_DIR/../packaging/launchd/$PLIST_FILENAME"
PLIST_DEST="$LAUNCH_AGENTS_DIR/$PLIST_FILENAME"
if [[ -f "$PLIST_TEMPLATE" ]]; then
    echo "==> Installing LaunchAgent plist to $PLIST_DEST..."
    mkdir -p "$LAUNCH_AGENTS_DIR"
    # Replace every $HOME literal in the template with the real home directory.
    sed "s|\$HOME|$HOME|g" "$PLIST_TEMPLATE" > "$PLIST_DEST"
    # Load into the launchd bootstrap namespace. RunAtLoad starts the engine
    # immediately. The bootout-wait above guarantees a clean load (no exit 5).
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null || true
    # Wait for the engine to bind its socket (confirms the process is ready).
    for _i in $(seq 1 30); do
        [ -S "$ION_HOME/engine.sock" ] && break
        sleep 0.2
    done
    if [ -S "$ION_HOME/engine.sock" ]; then
        echo "==> LaunchAgent $PLIST_LABEL started"
    else
        echo "  WARNING: engine socket not ready after 6s (engine may still be starting)"
    fi
else
    echo "  WARNING: plist template not found at $PLIST_TEMPLATE, skipping LaunchAgent install"
fi

# Install SDK for TypeScript extensions
SDK_SRC="$SCRIPT_DIR/extensions/sdk"
SDK_DST="$ION_HOME/extensions/sdk"
if [[ -d "$SDK_SRC" ]]; then
    echo "==> Installing extension SDK to $SDK_DST..."
    mkdir -p "$SDK_DST"
    cp -r "$SDK_SRC"/* "$SDK_DST/"
fi

# Install the Go extension SDK — DEVELOPER ASSET, source builds only.
#
# Unlike the TypeScript SDK above, this is a BUILD-TIME dependency, not a
# runtime one. That asymmetry is the whole reason this block lives here and
# not in the packaged install path:
#
#   TypeScript: the engine transpiles a .ts extension with esbuild at LOAD
#               time, on the machine running it, and the extension's
#               `from '../sdk/ion-sdk'` import must resolve to
#               $ION_HOME/extensions/sdk at that moment. Remove it and every
#               TS extension fails to load. It has to ship to every user.
#
#   Go:         `go build` statically links the SDK into the extension binary.
#               The engine just exec's that binary — nothing reads this
#               directory at runtime. Delete it after building and every Go
#               extension keeps working.
#
# So this belongs only where someone compiles: a source checkout running
# `make engine`. A packaged install (DMG/PKG/MDM) deliberately does NOT carry
# it — those machines run pre-built extension binaries and have no Go
# toolchain to use it with. Shipping it there would put a dev asset on every
# workstation for no runtime benefit.
#
# Deployment shape this supports: developers build here and get the SDK; what
# they hand to employees or a headless cluster is the engine binary plus the
# compiled extension binary, and nothing else.
#
# Source is the repository root's sdk/go, OUTSIDE the engine/ tree SCRIPT_DIR
# points at, so it is addressed relative to the repo root. That path exists
# only in a checkout, which is itself the guard: a packaged artifact has no
# sdk/go and takes the skip branch.
#
# Replace, don't merge: a deleted or renamed SDK file left behind here is a
# stale COMPILE input, and Go would happily build an extension against a
# surface the engine no longer has.
GO_SDK_SRC="$SCRIPT_DIR/../sdk/go"
GO_SDK_DST="$ION_HOME/extensions/sdk-go"
if [[ -d "$GO_SDK_SRC" ]]; then
    echo "==> Installing Go extension SDK to $GO_SDK_DST (developer asset)..."
    rm -rf "$GO_SDK_DST"
    mkdir -p "$GO_SDK_DST"
    # Module source only. Tests and their goldens are the repo's own
    # verification — testdata/ carries the SDK parity manifests, meaningless
    # outside the repo — and are not part of the surface an extension
    # compiles against.
    find "$GO_SDK_SRC" -maxdepth 1 -type f \
        \( -name '*.go' ! -name '*_test.go' -o -name 'go.mod' -o -name 'go.sum' -o -name 'README.md' -o -name 'VERSION' \) \
        -exec cp {} "$GO_SDK_DST/" \;
else
    echo "==> No Go SDK at $GO_SDK_SRC; skipping (not a source checkout)"
fi

VERSION=$("$BIN_DIR/ion" version 2>/dev/null || echo "unknown")
echo "==> Ion Engine $VERSION installed at $BIN_DIR/ion"
