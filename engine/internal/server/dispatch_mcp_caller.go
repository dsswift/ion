package server

// dispatch_mcp_caller.go — MCP login whose redirect the caller owns.
//
// mcp_login with mcpRedirectUri returns the authorization URL and starts no
// listener; the caller catches the provider's redirect on its own device and
// returns it through mcp_login_complete. Completion settles exactly like the
// loopback flow.

import (
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// beginCallerMcpLogin answers mcp_login when the caller supplied its own
// redirect URI.
func (s *Server) beginCallerMcpLogin(conn net.Conn, cmd *protocol.ClientCommand, cfg types.McpServerConfig) {
	authURL, err := mcp.BeginCallerLogin(cmd.McpName, cfg, cmd.McpScope, cmd.McpRedirectURI)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.mcp", "caller login start failed", map[string]any{
			"server": cmd.McpName, "redirect_uri": cmd.McpRedirectURI, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}

	s.emitMcpEventTo(conn, cmd.Key, types.EngineEvent{
		Type:                types.EventMcpLoginURL,
		McpServerName:       cmd.McpName,
		McpAuthorizationURL: authURL,
	})
	s.sendResult(conn, cmd, nil, map[string]any{
		"name":             cmd.McpName,
		"authorizationUrl": authURL,
	})
	utils.LogWithFields(utils.LevelInfo, "server.mcp", "caller login started", map[string]any{
		"server": cmd.McpName, "redirect_uri": cmd.McpRedirectURI,
	})
}

// dispatchMcpLoginComplete finishes a caller-redirect login with the callback
// URL the provider redirected to.
func (s *Server) dispatchMcpLoginComplete(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.McpName == "" || cmd.McpCallbackURL == "" {
		s.sendResult(conn, cmd, fmt.Errorf("mcp_login_complete requires mcpName and mcpCallbackUrl"), nil)
		return
	}

	if err := mcp.CompleteCallerLogin(cmd.McpName, cmd.McpCallbackURL); err != nil {
		s.sendResult(conn, cmd, err, nil)
		s.settleMcpLogin(s.serveContext(), cmd.McpName, cmd.Path, err)
		return
	}
	s.sendResult(conn, cmd, nil, map[string]any{"name": cmd.McpName})
	s.settleMcpLogin(s.serveContext(), cmd.McpName, cmd.Path, nil)
}
