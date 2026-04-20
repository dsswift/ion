#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ION_HOME="$HOME/.ion"
BIN_DIR="$ION_HOME/bin"

cd "$SCRIPT_DIR"

echo "==> Building Ion Engine..."
go build -o bin/ion ./cmd/ion

echo "==> Installing to $BIN_DIR..."
mkdir -p "$BIN_DIR"

# Stop running engine daemon so the new binary takes effect on next start
if pgrep -f "ion serve" >/dev/null 2>&1; then
  pkill -f "ion serve" 2>/dev/null || true
  sleep 1
fi

rm -f "$BIN_DIR/ion"
cp bin/ion "$BIN_DIR/ion"
chmod +x "$BIN_DIR/ion"
codesign --force --sign - "$BIN_DIR/ion" 2>/dev/null || true
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

# Install ion-meta extension
META_SRC="$SCRIPT_DIR/extensions/ion-meta"
META_DST="$ION_HOME/extensions/ion-meta"
if [[ -d "$META_SRC" ]]; then
    echo "==> Installing ion-meta extension to $META_DST..."
    mkdir -p "$META_DST"
    cp -r "$META_SRC"/* "$META_DST/"
fi

VERSION=$("$BIN_DIR/ion" version 2>/dev/null || echo "unknown")
echo "==> Ion Engine $VERSION installed at $BIN_DIR/ion"
