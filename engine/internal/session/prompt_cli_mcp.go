package session

import (
	"context"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// callMcpTool runs one tool call over a session's engine-held MCP connection,
// bounded by the engine's MCP call timeout. Every run kind routes MCP calls
// through here: an API run from its tool router, a delegated CLI run from the
// proxied server on its ToolServer.
func (m *Manager) callMcpTool(parent context.Context, s *engineSession, key string, conn *mcp.Connection, toolName string, input map[string]interface{}) (*types.ToolResult, error) {
	callCtx, callCancel := context.WithTimeout(parent, m.mcpCallTimeout())
	defer callCancel()
	result, err := conn.CallToolSpan(callCtx, toolName, input, s.telemetry, mcp.SpanCorrelation(parent, key, s.conversationID))
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session", "mcp tool call failed", map[string]any{"serverName": conn.Name(), "toolName": toolName, "conversation_id": key, "error": utils.ErrStr(err)})
		return nil, err
	}
	return result, nil
}

// wireMcpToolServer exposes the session's engine MCP connections to a
// delegated CLI run. The CLI is pointed only at the servers in the MCP config
// the engine writes for it, so without this a server the engine connected
// (and lists in the session's tools) never reaches the model.
//
// Runs after every other ToolServer wiring step, so the session's ToolServer
// exists. When one of those steps created and attached it this prompt, the
// attachment is refreshed to carry the proxied servers; otherwise
// ensureCliToolServerAttached attaches them with the rest.
func (m *Manager) wireMcpToolServer(s *engineSession, key string, opts *types.RunOptions, mcpConns []*mcp.Connection) {
	if len(mcpConns) == 0 {
		return
	}
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok {
		return
	}
	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()
	if ts == nil {
		utils.LogWithFields(utils.LevelError, "session", "engine MCP servers not proxied: no ToolServer for this run", map[string]any{"key": key, "kind": kind, "servers": len(mcpConns)})
		return
	}

	proxied := make(map[string]int, len(mcpConns))
	for _, conn := range mcpConns {
		for _, tool := range conn.Tools() {
			conn, toolName := conn, tool.Name
			handler := func(ctx context.Context, input map[string]interface{}) (*types.ToolResult, error) {
				return m.callMcpTool(ctx, s, key, conn, toolName, input)
			}
			if err := ts.ProxyMcpTool(conn.Name(), toolName, handler, tool.Description, tool.InputSchema); err != nil {
				utils.LogWithFields(utils.LevelError, "session", "engine MCP tool not proxied", map[string]any{"key": key, "serverName": conn.Name(), "toolName": toolName, "error": err.Error()})
				continue
			}
			proxied[conn.Name()]++
		}
	}

	attachedThisPrompt := opts.McpConfig != "" || len(opts.CliMcpServers) > 0
	if attachedThisPrompt {
		if err := backend.RefreshToolServerAttachment(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "engine MCP servers not attached to the run", map[string]any{"key": key, "kind": kind, "error": err.Error()})
			return
		}
	}
	utils.LogWithFields(utils.LevelInfo, "session", "engine MCP servers proxied to delegated CLI", map[string]any{"key": key, "kind": kind, "servers": proxied, "refreshed": attachedThisPrompt})
}
