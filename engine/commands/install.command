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
ENGINE_PID=""
if [[ -S "$ION_HOME/engine.sock" ]]; then
  ENGINE_PID=$(lsof -t "$ION_HOME/engine.sock" 2>/dev/null | head -1)
fi
if [[ -z "$ENGINE_PID" ]]; then
  ENGINE_PID=$(pgrep -f "ion serve" 2>/dev/null | head -1 || true)
fi
if [[ -n "$ENGINE_PID" ]]; then
  echo "==> Stopping engine daemon (PID $ENGINE_PID)..."
  # 1. Try graceful shutdown via socket command
  ./bin/ion shutdown 2>/dev/null &
  SHUTDOWN_PID=$!
  sleep 1
  kill $SHUTDOWN_PID 2>/dev/null || true
  # 2. SIGTERM
  if kill -0 "$ENGINE_PID" 2>/dev/null; then
    kill -TERM "$ENGINE_PID" 2>/dev/null || true
    sleep 1
  fi
  # 3. SIGKILL if still alive
  if kill -0 "$ENGINE_PID" 2>/dev/null; then
    echo "  Engine did not stop gracefully, forcing kill..."
    kill -9 "$ENGINE_PID" 2>/dev/null || true
    sleep 1
  fi
fi
# Clean up stale socket
rm -f "$ION_HOME/engine.sock"

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

VERSION=$("$BIN_DIR/ion" version 2>/dev/null || echo "unknown")
echo "==> Ion Engine $VERSION installed at $BIN_DIR/ion"
