package backend

import (
	"fmt"
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A delegated CLI only sees the MCP servers named in its own MCP config. The
// engine holds a session's MCP connections itself (it owns their OAuth grants,
// timeouts, and telemetry), so it proxies each one to the CLI as a server of
// the same name: the CLI sees mcp__<server>__<tool>, exactly the name an API
// run gives the tool, and every call runs over the engine's connection.
//
// Each proxied server is a child ToolServer with its own socket, reached
// through the same stdio bridge as the session's own server. It shares the
// parent's plan policy and stops with it.

// ProxyMcpTool exposes one tool of an engine-held MCP server to the delegated
// CLI under that server's name. The server's socket starts listening with the
// parent: at once when the parent is already running, else when it starts.
func (ts *ToolServer) ProxyMcpTool(server, tool string, handler ToolHandler, description string, inputSchema map[string]interface{}) error {
	if server == "" || server == ts.name {
		return fmt.Errorf("MCP server name %q is reserved for the engine's own tools", server)
	}
	ts.mu.Lock()
	child, exists := ts.proxied[server]
	if !exists {
		child = newNamedToolServer(ts.key, server, socketToken(ts.key+"\x00"+server))
		child.parent = ts
		if ts.proxied == nil {
			ts.proxied = make(map[string]*ToolServer)
		}
		ts.proxied[server] = child
	}
	startNow := !exists && ts.running
	ts.mu.Unlock()

	child.RegisterTool(tool, handler, description, inputSchema)
	if startNow {
		if err := child.Start(); err != nil {
			return fmt.Errorf("proxied MCP server %q: %w", server, err)
		}
	}
	return nil
}

// proxiedServers returns the proxied servers sorted by name. Callers hold ts.mu.
func (ts *ToolServer) proxiedServers() []*ToolServer {
	children := make([]*ToolServer, 0, len(ts.proxied))
	for _, child := range ts.proxied {
		children = append(children, child)
	}
	sort.Slice(children, func(i, j int) bool { return children[i].name < children[j].name })
	return children
}

// bridgedServers returns the servers the delegated CLI is pointed at: this one,
// then each proxied server that carries tools this prompt. A proxied server
// left empty by ResetTools (its connection is gone) keeps listening but is not
// offered.
func (ts *ToolServer) bridgedServers() []*ToolServer {
	ts.mu.Lock()
	children := ts.proxiedServers()
	ts.mu.Unlock()
	servers := []*ToolServer{ts}
	for _, child := range children {
		child.mu.Lock()
		hasTools := len(child.tools) > 0
		child.mu.Unlock()
		if hasTools {
			servers = append(servers, child)
		}
	}
	return servers
}

// RefreshToolServerAttachment brings a run that was already attached to ts
// this prompt up to date with the servers ts proxies now. claude-code re-reads
// its MCP config file at spawn, so the file is rewritten in place; the ACP
// backends take the proxied servers' specs alongside the one already appended.
func RefreshToolServerAttachment(opts *types.RunOptions, ts *ToolServer, sessionID, kind string) error {
	if kind == "acp" {
		specs := ts.McpServerSpecs()
		opts.CliMcpServers = append(opts.CliMcpServers, specs[1:]...)
		return nil
	}
	mcpPath, err := ts.McpConfigPath(sessionID)
	if err != nil {
		return err
	}
	opts.McpConfig = mcpPath
	utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "MCP config rewritten with proxied servers", map[string]any{"key": sessionID, "path": mcpPath})
	return nil
}
