package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// childCfgWithTools builds a RunConfig carrying one extension tool (routed via
// McpToolRouter) and an AgentSpawner, mirroring what the dispatch path assembles
// for a child before handing it off.
func childCfgWithTools(spawnerCalled, routerCalled *bool) *RunConfig {
	return &RunConfig{
		ExternalTools: []types.LlmToolDef{
			{Name: "emit_briefing", Description: "publish a briefing", InputSchema: map[string]interface{}{"type": "object"}},
		},
		McpToolRouter: func(_ context.Context, _ string, _ map[string]interface{}) (*types.ToolResult, error) {
			*routerCalled = true
			return &types.ToolResult{Content: "routed"}, nil
		},
		AgentSpawner: func(_ context.Context, _, _, _, _, _ string) (string, error) {
			*spawnerCalled = true
			return "grandchild done", nil
		},
	}
}

// TestBuildDelegatedChildToolServer_ApiChildNoServer verifies an API-routed
// child gets no tool server (it consumes the RunConfig directly) and its
// RunOptions are untouched.
func TestBuildDelegatedChildToolServer_ApiChildNoServer(t *testing.T) {
	var sp, rt bool
	cfg := childCfgWithTools(&sp, &rt)
	opts := &types.RunOptions{Model: "gpt-5"}

	ts, err := BuildDelegatedChildToolServer(NewApiBackend(), "child-api", cfg, opts)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if ts != nil {
		t.Fatal("API-routed child must not get a tool server")
	}
	if opts.McpConfig != "" || len(opts.CliMcpServers) != 0 {
		t.Errorf("API child RunOptions mutated: mcpConfig=%q cliMcp=%v", opts.McpConfig, opts.CliMcpServers)
	}
}

// TestBuildDelegatedChildToolServer_ClaudeChild verifies a claude-code child
// gets a tool server carrying its extension tools + ion_agent, attached via
// the --mcp-config file path.
func TestBuildDelegatedChildToolServer_ClaudeChild(t *testing.T) {
	var sp, rt bool
	cfg := childCfgWithTools(&sp, &rt)
	opts := &types.RunOptions{Model: "claude-opus-4-8"}

	ts, err := BuildDelegatedChildToolServer(NewClaudeCodeBackend(), "child-cc", cfg, opts)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if ts == nil {
		t.Fatal("claude-code child must get a tool server")
	}
	defer ts.Stop()

	if opts.McpConfig == "" {
		t.Error("claude-code child: McpConfig path not set")
	}
	if len(opts.CliMcpServers) != 0 {
		t.Error("claude-code child: CliMcpServers should be empty (uses config file)")
	}
	if !ts.HasTool("emit_briefing") {
		t.Error("child tool server missing the extension tool (emit_briefing)")
	}
	if !ts.HasTool("ion_agent") {
		t.Error("child tool server missing ion_agent (child cannot dispatch grandchildren)")
	}
}

// TestBuildDelegatedChildToolServer_AcpChild verifies a grok child gets the
// inline mcpServers spec (opts.CliMcpServers) and the same tool set.
func TestBuildDelegatedChildToolServer_AcpChild(t *testing.T) {
	var sp, rt bool
	cfg := childCfgWithTools(&sp, &rt)
	opts := &types.RunOptions{Model: "grok-code"}

	ts, err := BuildDelegatedChildToolServer(NewGrokBackend(), "child-grok", cfg, opts)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if ts == nil {
		t.Fatal("grok child must get a tool server")
	}
	defer ts.Stop()

	if opts.McpConfig != "" {
		t.Error("acp child: McpConfig should be empty")
	}
	if len(opts.CliMcpServers) != 1 {
		t.Fatalf("acp child: want 1 inline mcp server, got %d", len(opts.CliMcpServers))
	}
	if !ts.HasTool("emit_briefing") || !ts.HasTool("ion_agent") {
		t.Error("acp child tool server missing expected tools")
	}
}

// TestBuildDelegatedChildToolServer_NoSpawnerOmitsIonAgent verifies ion_agent
// is omitted (not registered broken) when the child cfg has no AgentSpawner.
func TestBuildDelegatedChildToolServer_NoSpawnerOmitsIonAgent(t *testing.T) {
	cfg := &RunConfig{
		ExternalTools: []types.LlmToolDef{{Name: "emit_briefing", InputSchema: map[string]interface{}{"type": "object"}}},
	}
	opts := &types.RunOptions{Model: "claude-opus-4-8"}
	ts, err := BuildDelegatedChildToolServer(NewClaudeCodeBackend(), "child-nospawn", cfg, opts)
	if err != nil || ts == nil {
		t.Fatalf("build: ts=%v err=%v", ts, err)
	}
	defer ts.Stop()
	if ts.HasTool("ion_agent") {
		t.Error("ion_agent should be omitted when no AgentSpawner is wired")
	}
	if !ts.HasTool("emit_briefing") {
		t.Error("extension tool should still be registered")
	}
}
