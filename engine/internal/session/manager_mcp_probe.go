package session

// manager_mcp_probe.go — one connect attempt that refreshes a server's
// recorded connect error when no live session can.

import (
	"context"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ProbeMcpServer connects to one server, records the outcome as its connect
// error (cleared on success), and closes the connection. It returns the connect
// error, or nil.
//
// The recorded error describes the last attempt. After a sign-in or a config
// change that attempt predates the change, and with no live session to
// reconnect nothing would replace it: the server would keep reporting a failure
// its new credentials or definition may have fixed. The probe replaces it with
// the result of an attempt made now.
func (m *Manager) ProbeMcpServer(ctx context.Context, name, projectDir string) error {
	cfg, ok := ionconfig.ResolveMcpServers(projectDir)[name]
	if !ok {
		m.clearMcpConnectError(name)
		utils.LogWithFields(utils.LevelInfo, "session", "mcp probe skipped; server not configured", map[string]any{
			"serverName": name, "project_dir": projectDir,
		})
		return nil
	}
	conn, err := mcp.ConnectContext(ctx, name, cfg, mcp.ConnectionOptions{})
	if err != nil {
		m.recordMcpConnectError(name, err)
		utils.LogWithFields(utils.LevelInfo, "session", "mcp probe failed", map[string]any{
			"serverName": name, "error": utils.ErrStr(err),
		})
		return err
	}
	m.clearMcpConnectError(name)
	toolCount := len(conn.Tools())
	if closeErr := conn.Close(); closeErr != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "mcp probe: close failed", map[string]any{
			"serverName": name, "error": closeErr.Error(),
		})
	}
	utils.LogWithFields(utils.LevelInfo, "session", "mcp probe connected", map[string]any{
		"serverName": name, "toolCount": toolCount,
	})
	return nil
}
