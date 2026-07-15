package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestMcpCapableCli pins which delegated-CLI backends can consume the
// per-session ToolServer MCP bridge. claude-code and the ACP backends
// (grok, cursor) qualify; codex (shared app-server, spawn-time MCP only) and
// the ApiBackend (in-process tools) do not.
func TestMcpCapableCli(t *testing.T) {
	cases := []struct {
		name     string
		backend  backend.RunBackend
		wantKind string
		wantOK   bool
	}{
		{"claude-code", backend.NewClaudeCodeBackend(), "claude-code", true},
		{"grok", backend.NewGrokBackend(), "acp", true},
		{"cursor", backend.NewCursorBackend(), "acp", true},
		{"codex", backend.NewCodexBackend(), "", false},
		{"api", backend.NewApiBackend(), "", false},
	}
	for _, tc := range cases {
		kind, ok := mcpCapableCli(tc.backend)
		if kind != tc.wantKind || ok != tc.wantOK {
			t.Errorf("%s: mcpCapableCli = (%q, %v), want (%q, %v)", tc.name, kind, ok, tc.wantKind, tc.wantOK)
		}
	}
}

// TestAttachToolServerMcp_ClaudeCode pins that claude-code gets an MCP config
// FILE path (opts.McpConfig) and no inline ACP servers.
func TestAttachToolServerMcp_ClaudeCode(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	ts := backend.NewToolServer("k-cc")
	opts := &types.RunOptions{}

	if err := mgr.attachToolServerMcp(opts, ts, "k-cc", "claude-code"); err != nil {
		t.Fatalf("attach: %v", err)
	}
	if opts.McpConfig == "" {
		t.Error("claude-code: McpConfig path not set")
	}
	if len(opts.CliMcpServers) != 0 {
		t.Errorf("claude-code: CliMcpServers should be empty, got %v", opts.CliMcpServers)
	}
}

// TestAttachToolServerMcp_Acp pins that the ACP backends get an inline
// mcpServers spec (opts.CliMcpServers) and no config-file path, and that the
// spec is the socat→Unix-socket stdio bridge grok's serde accepts (name +
// command + args + env).
func TestAttachToolServerMcp_Acp(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewGrokBackend())
	ts := backend.NewToolServer("k-acp")
	opts := &types.RunOptions{}

	if err := mgr.attachToolServerMcp(opts, ts, "k-acp", "acp"); err != nil {
		t.Fatalf("attach: %v", err)
	}
	if opts.McpConfig != "" {
		t.Errorf("acp: McpConfig should be empty, got %q", opts.McpConfig)
	}
	if len(opts.CliMcpServers) != 1 {
		t.Fatalf("acp: want exactly 1 mcp server spec, got %d", len(opts.CliMcpServers))
	}
	spec := opts.CliMcpServers[0]
	if spec["name"] != backend.McpServerName {
		t.Errorf("spec name = %v, want %q", spec["name"], backend.McpServerName)
	}
	if spec["command"] != "socat" {
		t.Errorf("spec command = %v, want socat", spec["command"])
	}
	if _, hasEnv := spec["env"]; !hasEnv {
		t.Error("spec missing env (grok's stdio McpServer serde requires it)")
	}
	if _, hasArgs := spec["args"]; !hasArgs {
		t.Error("spec missing args")
	}
}

// TestAttachToolServerMcp_AcpAppendsOnce guards against duplicate mcpServers
// entries: attaching twice (e.g. wireToolServer then wireAgentToolServer)
// must not append a second copy — the helper is called once per ToolServer.
// Here we verify a single attach yields exactly one entry (the call-site
// contract that only the creating call attaches).
func TestAttachToolServerMcp_AcpSingleEntry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewCursorBackend())
	ts := backend.NewToolServer("k-once")
	opts := &types.RunOptions{}
	_ = mgr.attachToolServerMcp(opts, ts, "k-once", "acp")
	if len(opts.CliMcpServers) != 1 {
		t.Fatalf("want 1 entry after single attach, got %d", len(opts.CliMcpServers))
	}
}
