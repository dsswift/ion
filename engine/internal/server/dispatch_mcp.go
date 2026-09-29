package server

// dispatch_mcp.go — MCP server administration over the engine wire.
//
// Commands: mcp_list, mcp_add, mcp_update (dispatch_mcp_update.go),
// mcp_remove, mcp_login, mcp_login_complete, mcp_logout. They
// give every consumer — the ion CLI, the desktop, a third-party client — the
// same administration surface, so none of them has to reimplement discovery,
// registration, or the PKCE exchange.
//
// dispatchMcpLogin follows the dispatchOidcBeginLogin template exactly: return
// the authorization URL immediately, emit it to the requesting client, and run
// the exchange on a background goroutine. The dispatch never blocks on a human
// (see engine/AGENTS.md § "Core principle"): the client's read loop stays free
// while the operator is in their browser.

import (
	"encoding/json"
	"fmt"
	"net"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchMcp routes one MCP administration command to its handler.
func (s *Server) dispatchMcp(conn net.Conn, cmd *protocol.ClientCommand) {
	switch cmd.Cmd {
	case "mcp_list":
		s.dispatchMcpList(conn, cmd)
	case "mcp_add":
		s.dispatchMcpAdd(conn, cmd)
	case "mcp_update":
		s.dispatchMcpUpdate(conn, cmd)
	case "mcp_remove":
		s.dispatchMcpRemove(conn, cmd)
	case "mcp_login":
		s.dispatchMcpLogin(conn, cmd)
	case "mcp_login_complete":
		s.dispatchMcpLoginComplete(conn, cmd)
	case "mcp_logout":
		s.dispatchMcpLogout(conn, cmd)
	default:
		utils.LogWithFields(utils.LevelError, "server.mcp", "unrouted mcp command", map[string]any{"cmd": cmd.Cmd})
		s.sendResult(conn, cmd, fmt.Errorf("unknown MCP command %q", cmd.Cmd), nil)
	}
}

// dispatchMcpList answers with the complete MCP server snapshot, delivered as
// an engine_mcp_servers event to the requester plus a result payload for the
// await-result pattern (mirrors dispatchOidcIdentity).
func (s *Server) dispatchMcpList(conn net.Conn, cmd *protocol.ClientCommand) {
	evt := s.mcpServersEvent(cmd.Path)
	s.emitMcpEventTo(conn, cmd.Key, evt)
	s.sendResult(conn, cmd, nil, map[string]any{"servers": evt.McpServers})
	utils.LogWithFields(utils.LevelInfo, "server.mcp", "server list delivered", map[string]any{
		"count": len(evt.McpServers), "project_dir": cmd.Path,
	})
}

// dispatchMcpAdd writes a server into engine.json and broadcasts the updated
// snapshot. The write is rejected when enterprise policy forbids the server, so
// a consumer hears the refusal instead of watching the entry be silently pruned
// at the next session start.
func (s *Server) dispatchMcpAdd(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.McpName == "" {
		s.sendResult(conn, cmd, fmt.Errorf("mcp_add requires mcpName"), nil)
		return
	}

	cfg, err := mcpConfigFromCommand(cmd)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "server.mcp", "add rejected: invalid server definition", map[string]any{
			"server": cmd.McpName, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}

	if err := ionconfig.AddMcpServer(cmd.McpName, cfg); err != nil {
		utils.LogWithFields(utils.LevelError, "server.mcp", "add failed", map[string]any{
			"server": cmd.McpName, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}

	utils.LogWithFields(utils.LevelInfo, "server.mcp", "server added", map[string]any{
		"server": cmd.McpName, "transport": cfg.Type, "url": cfg.URL, "command": cfg.Command,
		"oauth_configured": cfg.OAuth != nil,
	})
	s.sendResult(conn, cmd, nil, map[string]any{"name": cmd.McpName, "transport": cfg.Type})
	s.broadcastMcpServers(cmd.Path)
}

// dispatchMcpRemove deletes a server from engine.json and broadcasts the
// updated snapshot.
//
// Stored credentials go with it. Leaving a token and client registration behind
// for a server the operator just deleted would silently re-authorize it if the
// name were ever reused, and would leave secrets on disk for a server that no
// longer exists.
func (s *Server) dispatchMcpRemove(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.McpName == "" {
		s.sendResult(conn, cmd, fmt.Errorf("mcp_remove requires mcpName"), nil)
		return
	}

	if err := ionconfig.RemoveMcpServer(cmd.McpName); err != nil {
		utils.LogWithFields(utils.LevelInfo, "server.mcp", "remove failed", map[string]any{
			"server": cmd.McpName, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	mcp.Logout(cmd.McpName)

	utils.LogWithFields(utils.LevelInfo, "server.mcp", "server removed with its stored credentials", map[string]any{
		"server": cmd.McpName,
	})
	s.sendResult(conn, cmd, nil, map[string]any{"name": cmd.McpName})
	s.broadcastMcpServers(cmd.Path)
}

// dispatchMcpLogin starts the interactive OAuth flow for a server. Returns the
// authorization URL immediately; the exchange completes on a background
// goroutine, after which the server is reconnected across live sessions and the
// updated snapshot is broadcast.
func (s *Server) dispatchMcpLogin(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.McpName == "" {
		s.sendResult(conn, cmd, fmt.Errorf("mcp_login requires mcpName"), nil)
		return
	}

	servers := ionconfig.ResolveMcpServers(cmd.Path)
	cfg, ok := servers[cmd.McpName]
	if !ok {
		// Naming the remediation matters: the server may be absent because it
		// was never added, or because enterprise policy pruned it, and the
		// consumer cannot tell those apart from a bare "not found".
		err := fmt.Errorf("MCP server %q is not configured (add it first, and check enterprise policy if you expected it to be present)", cmd.McpName)
		utils.LogWithFields(utils.LevelInfo, "server.mcp", "login rejected: server not configured", map[string]any{
			"server": cmd.McpName, "project_dir": cmd.Path,
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}

	if cmd.McpRedirectURI != "" {
		s.beginCallerMcpLogin(conn, cmd, cfg)
		return
	}

	login, err := mcp.BeginLogin(cmd.McpName, cfg, cmd.McpScope)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.mcp", "login start failed", map[string]any{
			"server": cmd.McpName, "error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}

	s.emitMcpEventTo(conn, cmd.Key, types.EngineEvent{
		Type:                types.EventMcpLoginURL,
		McpServerName:       cmd.McpName,
		McpAuthorizationURL: login.AuthorizationURL,
	})
	s.sendResult(conn, cmd, nil, map[string]any{
		"name":             cmd.McpName,
		"authorizationUrl": login.AuthorizationURL,
	})

	// Complete in the background; the engine never blocks a dispatch on user
	// action. The flow carries its own 5-minute deadline (auth.StartPKCEFlow),
	// so this goroutine cannot outlive it.
	name := cmd.McpName
	projectDir := cmd.Path
	go func() {
		select {
		case <-login.Done:
			s.settleMcpLogin(name, projectDir, nil)
		case loginErr := <-login.Err:
			s.settleMcpLogin(name, projectDir, loginErr)
		}
	}()
}

// settleMcpLogin is where every login attempt ends, whichever redirect it
// used: a success reconnects the server across live sessions, and either way
// the snapshot is broadcast — its authenticated flag is how a consumer learns
// the attempt left the server unauthorized. When no live session reconnected,
// a probe refreshes the recorded connect error, which otherwise still reports
// the failure from before the sign-in.
func (s *Server) settleMcpLogin(name, projectDir string, loginErr error) {
	if loginErr != nil {
		utils.LogWithFields(utils.LevelInfo, "server.mcp", "login did not complete", map[string]any{
			"server": name, "error": loginErr.Error(),
		})
	} else {
		reconnected := s.reconnectMcpAcrossSessions(name)
		probed := reconnected == 0 && s.probeMcpServer(name, projectDir)
		utils.LogWithFields(utils.LevelInfo, "server.mcp", "login completed", map[string]any{
			"server": name, "sessions_reconnected": reconnected, "probed": probed,
		})
	}
	s.broadcastMcpServers(projectDir)
}

// dispatchMcpLogout drops a server's stored token and client registration, then
// broadcasts the updated snapshot.
func (s *Server) dispatchMcpLogout(conn net.Conn, cmd *protocol.ClientCommand) {
	if cmd.McpName == "" {
		s.sendResult(conn, cmd, fmt.Errorf("mcp_logout requires mcpName"), nil)
		return
	}
	mcp.Logout(cmd.McpName)
	utils.LogWithFields(utils.LevelInfo, "server.mcp", "logged out", map[string]any{"server": cmd.McpName})
	s.sendResult(conn, cmd, nil, map[string]any{"name": cmd.McpName})
	s.broadcastMcpServers(cmd.Path)
}

// reconnectMcpAcrossSessions asks the session manager to re-establish a server
// on every live session. Guarded because a Server can exist without a manager
// in tests.
func (s *Server) reconnectMcpAcrossSessions(name string) int {
	if s.manager == nil {
		return 0
	}
	return s.manager.ReconnectMcpServer(name)
}

// mcpConfigFromCommand builds a server config from an mcp_add command. The
// transport is inferred when the consumer did not state one (see
// config.NormalizeMcpServerConfig).
func mcpConfigFromCommand(cmd *protocol.ClientCommand) (types.McpServerConfig, error) {
	cfg := types.McpServerConfig{
		Type:    cmd.McpTransport,
		URL:     cmd.McpURL,
		Command: cmd.McpCommand,
		Args:    cmd.McpArgs,
		Env:     cmd.McpEnv,
		Headers: cmd.McpHeaders,
		OAuth:   mcpOAuthConfigFromSettings(cmd.McpOAuth),
	}
	if err := ionconfig.NormalizeMcpServerConfig(&cfg); err != nil {
		return types.McpServerConfig{}, err
	}
	return cfg, nil
}

// probeMcpServer refreshes a server's recorded connect error with a fresh
// attempt. Returns whether a probe ran; a Server without a manager (tests) has
// nothing to probe.
func (s *Server) probeMcpServer(name, projectDir string) bool {
	if s.manager == nil {
		return false
	}
	//nolint:errcheck // the outcome is recorded as the server's connect error and logged by the probe
	_ = s.manager.ProbeMcpServer(name, projectDir)
	return true
}

// mcpOAuthConfigFromSettings converts the wire OAuth settings into an
// engine.json oauth block, or nil when no setting is present: an empty block
// on disk would read as "operator-configured" while configuring nothing.
func mcpOAuthConfigFromSettings(settings *protocol.McpOAuthSettings) *types.McpOAuthConfig {
	if settings == nil {
		return nil
	}
	oauth := &types.McpOAuthConfig{
		ClientID: settings.ClientID,
		AuthURL:  settings.AuthURL,
		TokenURL: settings.TokenURL,
		Scope:    settings.Scope,
		Resource: settings.Resource,
	}
	if settings.ClientSecret != nil {
		oauth.ClientSecret = *settings.ClientSecret
	}
	if *oauth == (types.McpOAuthConfig{}) {
		return nil
	}
	return oauth
}

// mcpServersEvent builds the complete server snapshot event.
func (s *Server) mcpServersEvent(projectDir string) types.EngineEvent {
	evt := types.EngineEvent{Type: types.EventMcpServers}
	if s.manager != nil {
		evt.McpServers = s.manager.McpServerStatuses(projectDir)
	}
	return evt
}

// emitMcpEventTo delivers an MCP event to a single client connection (the
// requester), rather than broadcasting it.
func (s *Server) emitMcpEventTo(conn net.Conn, key string, evt types.EngineEvent) {
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.mcp", "mcp event marshal failed", map[string]any{
			"type": evt.Type, "error": err.Error(),
		})
		return
	}
	s.writeToClient(conn, protocol.SerializeServerEvent(key, json.RawMessage(raw)))
}

// broadcastMcpServers sends the complete server snapshot to every connected
// client. Called on each state transition (add, remove, login, logout) so a
// change made from one client reaches all of them.
func (s *Server) broadcastMcpServers(projectDir string) {
	evt := s.mcpServersEvent(projectDir)
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.mcp", "server snapshot marshal failed", map[string]any{"error": err.Error()})
		return
	}
	s.broadcast(protocol.SerializeServerEvent("", json.RawMessage(raw)), evt.Type)
	utils.LogWithFields(utils.LevelInfo, "server.mcp", "server snapshot broadcast", map[string]any{
		"count": len(evt.McpServers),
	})
}
