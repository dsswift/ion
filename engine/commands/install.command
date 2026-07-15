#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ION_HOME="$HOME/.ion"
BIN_DIR="$ION_HOME/bin"
PLIST_LABEL="com.ion.engine"
PLIST_FILENAME="com.ion.engine.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

cd "$SCRIPT_DIR"

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
# with no prompt. A certificate-backed signature keeps identifier "ion" and a
# stable designated requirement, so the grant survives rebuilds. Identity
# precedence mirrors desktop/scripts/afterPack.js: APPLE_SIGNING_IDENTITY env,
# then the "Ion Local Dev" self-signed cert, then ad-hoc as a last resort.
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-Ion Local Dev}"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$SIGN_IDENTITY"; then
    echo "==> Signing engine binary (identity: $SIGN_IDENTITY)..."
    codesign --force --sign "$SIGN_IDENTITY" --identifier ion --options runtime "$BIN_DIR/ion" \
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

# Install ion-meta extension
META_SRC="$SCRIPT_DIR/extensions/ion-meta"
META_DST="$ION_HOME/extensions/ion-meta"
if [[ -d "$META_SRC" ]]; then
    echo "==> Installing ion-meta extension to $META_DST..."
    mkdir -p "$META_DST"
    cp -r "$META_SRC"/* "$META_DST/"
fi

# Ship canonical Ion documentation into ion-meta so the bundled
# `ion_read_doc` tool can serve them without any repo-relative path
# resolution. The four allow-listed namespaces match what the tool
# accepts: extensions/, hooks/, agents/, architecture/.
#
# Layout written:
#   ~/.ion/extensions/ion-meta/docs/canonical/extensions/...
#   ~/.ion/extensions/ion-meta/docs/canonical/hooks/...
#   ~/.ion/extensions/ion-meta/docs/canonical/agents/...
#   ~/.ion/extensions/ion-meta/docs/canonical/architecture/adr/...
#
# Re-copied on every install so renames and deletions propagate (cp -r
# alone leaves orphans). We delete the canonical/ tree first.
REPO_DOCS="$SCRIPT_DIR/../docs"
CANON_DST="$META_DST/docs/canonical"
if [[ -d "$META_DST" && -d "$REPO_DOCS" ]]; then
    echo "==> Bundling canonical docs into $CANON_DST..."
    rm -rf "$CANON_DST"
    mkdir -p "$CANON_DST"
    for ns in extensions hooks agents; do
        if [[ -d "$REPO_DOCS/$ns" ]]; then
            cp -r "$REPO_DOCS/$ns" "$CANON_DST/$ns"
        fi
    done
    # ADRs sit under architecture/adr; ship the whole architecture tree
    # so the orchestration-designer specialist can cite ADR-001..003 and
    # the agent-state doc by path.
    if [[ -d "$REPO_DOCS/architecture" ]]; then
        cp -r "$REPO_DOCS/architecture" "$CANON_DST/architecture"
    fi
fi

VERSION=$("$BIN_DIR/ion" version 2>/dev/null || echo "unknown")
echo "==> Ion Engine $VERSION installed at $BIN_DIR/ion"
