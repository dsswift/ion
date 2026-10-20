package backend

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func readConfigSockets(t *testing.T, configPath string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var cfg struct {
		McpServers map[string]struct {
			Args []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}
	sockets := make(map[string]string, len(cfg.McpServers))
	for name, server := range cfg.McpServers {
		for i, arg := range server.Args {
			if arg == "--socket" && i+1 < len(server.Args) {
				sockets[name] = server.Args[i+1]
			}
		}
	}
	return sockets
}

func listToolNames(t *testing.T, sockPath string) []string {
	t.Helper()
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial %s: %v", sockPath, err)
	}
	defer conn.Close()
	initializeSession(t, conn)
	resp := sendJSONRPC(t, conn, "tools/list", 1, map[string]interface{}{})
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("tools/list: %v", resp)
	}
	var names []string
	for _, item := range result["tools"].([]interface{}) {
		names = append(names, item.(map[string]interface{})["name"].(string))
	}
	return names
}

func proxyEcho(t *testing.T, ts *ToolServer, server, tool string) {
	t.Helper()
	err := ts.ProxyMcpTool(server, tool, func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		query, _ := input["query"].(string) //nolint:errcheck // test
		return &types.ToolResult{Content: server + ":" + query}, nil
	}, "Search", map[string]interface{}{"type": "object"})
	if err != nil {
		t.Fatalf("ProxyMcpTool: %v", err)
	}
}

// The CLI must see an engine MCP server under that server's own name, served
// over the engine's handler, beside the session's own server.
func TestProxyMcpTool_ServedUnderServerName(t *testing.T) {
	ts := NewToolServer("proxy-served")
	ts.RegisterTool("ion_agent", func(_ context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "ok"}, nil
	}, "Agent", nil)
	if err := ts.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer ts.Stop()
	proxyEcho(t, ts, "mobbin", "search_screens")

	configPath, err := ts.McpConfigPath("proxy-served")
	if err != nil {
		t.Fatalf("McpConfigPath: %v", err)
	}
	sockets := readConfigSockets(t, configPath)
	if len(sockets) != 2 || sockets[McpServerName] == "" || sockets["mobbin"] == "" {
		t.Fatalf("config servers = %v, want %s and mobbin", sockets, McpServerName)
	}

	if names := listToolNames(t, sockets["mobbin"]); len(names) != 1 || names[0] != "search_screens" {
		t.Fatalf("mobbin tools = %v, want [search_screens]", names)
	}
	for _, name := range listToolNames(t, sockets[McpServerName]) {
		if name == "search_screens" {
			t.Fatalf("proxied tool leaked onto %s", McpServerName)
		}
	}

	conn, err := net.Dial("unix", sockets["mobbin"])
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	initializeSession(t, conn)
	resp := sendJSONRPC(t, conn, "tools/call", 2, map[string]interface{}{
		"name":      "search_screens",
		"arguments": map[string]interface{}{"query": "onboarding"},
	})
	content := resp["result"].(map[string]interface{})["content"].([]interface{})
	if text := content[0].(map[string]interface{})["text"]; text != "mobbin:onboarding" {
		t.Fatalf("tools/call text = %v", text)
	}

	if specs := ts.McpServerSpecs(); len(specs) != 2 || specs[1]["name"] != "mobbin" {
		t.Fatalf("ACP specs = %v", specs)
	}
}

// A proxied server whose tools were reset (its connection is gone) is no longer
// offered to the CLI.
func TestProxyMcpTool_ResetDropsServerFromConfig(t *testing.T) {
	ts := NewToolServer("proxy-reset")
	proxyEcho(t, ts, "mobbin", "search_screens")
	ts.ResetTools()

	configPath, err := ts.McpConfigPath("proxy-reset")
	if err != nil {
		t.Fatalf("McpConfigPath: %v", err)
	}
	defer os.Remove(configPath) //nolint:errcheck // test cleanup
	if sockets := readConfigSockets(t, configPath); len(sockets) != 1 || sockets[McpServerName] == "" {
		t.Fatalf("config servers = %v, want only %s", sockets, McpServerName)
	}
}

// While planning, a proxied tool runs only when the MCP allowlist names it,
// the same rule an API run applies to mcp__<server>__<tool>.
func TestProxyMcpTool_PlanPolicy(t *testing.T) {
	ts := NewToolServer("proxy-plan")
	proxyEcho(t, ts, "mobbin", "search_screens")
	child := ts.proxied["mobbin"]

	for _, tc := range []struct {
		allowlist []string
		wantError bool
	}{
		{allowlist: []string{"mcp__mobbin"}, wantError: false},
		{allowlist: nil, wantError: true},
	} {
		allowlist := tc.allowlist
		ts.SetPlanPolicySource(func() (PlanPolicy, bool) { return PlanPolicy{McpAllowlist: allowlist}, true })
		res, found, err := child.InvokeTool(context.Background(), "search_screens", map[string]interface{}{"query": "x"})
		if !found || err != nil {
			t.Fatalf("InvokeTool found=%v err=%v", found, err)
		}
		if res.IsError != tc.wantError {
			t.Fatalf("allowlist %v: IsError=%v (%q), want %v", allowlist, res.IsError, res.Content, tc.wantError)
		}
	}
}

func TestProxyMcpTool_RefusesEngineServerName(t *testing.T) {
	ts := NewToolServer("proxy-reserved")
	err := ts.ProxyMcpTool(McpServerName, "x", nil, "", nil)
	if err == nil {
		t.Fatalf("expected an error proxying a server named %s", McpServerName)
	}
}
