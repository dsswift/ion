package server

// dispatch_mcp_update.go — mcp_update: edit one configured MCP server in place.

import (
	"context"
	"fmt"
	"net"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchMcpUpdate patches a server in engine.json, keeping every field the
// command does not name.
//
// When the url or the OAuth client changes, the stored token and client
// registration go: they were minted for the old client and resource, and
// refreshing them against the new one would fail or, worse, authorize the
// wrong grant. Live sessions reconnect so the edit takes effect without a new
// conversation; with none, a probe refreshes the recorded connect error.
func (s *Server) dispatchMcpUpdate(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.McpName == "" {
		s.sendResult(conn, cmd, fmt.Errorf("mcp_update requires mcpName"), nil)
		return
	}

	patch := ionconfig.McpServerPatch{
		Transport: cmd.McpTransport,
		URL:       cmd.McpURL,
		Command:   cmd.McpCommand,
		Args:      cmd.McpArgs,
		OAuth:     mcpOAuthPatchFromSettings(cmd.McpOAuth),
	}
	result, err := ionconfig.UpdateMcpServer(cmd.McpName, patch)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "server.mcp", "update rejected", map[string]any{
			"server": cmd.McpName, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}

	credentialsCleared := result.CredentialsInvalidated && mcp.HasStoredCredentials(cmd.McpName)
	if credentialsCleared {
		mcp.Logout(cmd.McpName)
	}
	utils.LogWithFields(utils.LevelInfo, "server.mcp", "server updated", map[string]any{
		"server": cmd.McpName, "changed": result.Changed,
		"credentials_invalidated": result.CredentialsInvalidated, "credentials_cleared": credentialsCleared,
	})
	s.sendResult(conn, cmd, nil, map[string]any{
		"name":               cmd.McpName,
		"changed":            result.Changed,
		"credentialsCleared": credentialsCleared,
	})
	s.broadcastMcpServers(cmd.Path)

	if result.Changed {
		// Reconnecting and probing dial the server, so they run off the
		// dispatch; the snapshot is broadcast again with their outcome.
		name, projectDir := cmd.McpName, cmd.Path
		s.startMcpWork("update_reconnect", name, func(ctx context.Context) {
			reconnected := s.reconnectMcpAcrossSessions(ctx, name)
			// The recorded connect error described the old definition.
			probed := reconnected == 0 && s.probeMcpServer(ctx, name, projectDir)
			utils.LogWithFields(utils.LevelInfo, "server.mcp", "updated server reconnected", map[string]any{
				"server": name, "sessions_reconnected": reconnected, "probed": probed,
			})
			s.broadcastMcpServers(projectDir)
		})
	}
}

// mcpOAuthPatchFromSettings converts the wire OAuth settings into a config
// patch. Absent settings leave the stored client untouched.
func mcpOAuthPatchFromSettings(settings *protocol.McpOAuthSettings) *ionconfig.McpOAuthPatch {
	if settings == nil {
		return nil
	}
	return &ionconfig.McpOAuthPatch{
		ClientID:     settings.ClientID,
		ClientSecret: settings.ClientSecret,
		AuthURL:      settings.AuthURL,
		TokenURL:     settings.TokenURL,
		Scope:        settings.Scope,
		Resource:     settings.Resource,
	}
}
