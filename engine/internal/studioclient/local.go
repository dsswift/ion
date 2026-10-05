package studioclient

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"path/filepath"

	"github.com/coder/websocket"

	"github.com/dsswift/ion/engine/internal/utils"
)

// The server on this machine listens for same-machine processes on a local
// address: a Unix socket in the data directory, or a named pipe on Windows.
// A process that can open it is trusted with every scope, so no pairing or
// sign-in is involved.

// LocalSocketName is the Unix socket's file name under the data directory.
const LocalSocketName = "studio.sock"

// ConnectLocal opens a Studio connection to this machine's own server, whose
// data directory is dataDir, in the thin view, and waits for the welcome.
func ConnectLocal(ctx context.Context, dataDir string) (*Session, error) {
	where := localAddress(dataDir)
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialLocal(ctx, where)
	}}}
	conn, _, err := websocket.Dial(ctx, "ws://localhost/studio", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, logTag, "local studio connection failed", map[string]any{"address": where, "error": err.Error()})
		return nil, fmt.Errorf("connect to this machine's server at %s: %w", where, err)
	}
	conn.SetReadLimit(16 << 20)
	s := &Session{conn: conn}
	hello := map[string]any{
		"type": "studio_hello", "protocolVersion": studioProtocolVersion, "clientId": helloClientID(),
		"clientKind": "desktop", "capabilities": []string{}, "view": "thin",
		"credential": map[string]any{"kind": "local"},
	}
	if err := s.handshake(ctx, hello, where); err != nil {
		return nil, err
	}
	return s, nil
}

func unixAddress(dataDir string) string {
	return filepath.Join(dataDir, LocalSocketName)
}
