package session

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// Under the CLI's tool search, the engine's own bridged tools stay loaded and
// an extension tool loads on demand unless the extension marked it
// always-load. Revert-check: register every tool with RegisterTool and the
// engine tools lose their always-load mark.
func TestCliToolServer_EngineToolsAlwaysLoadExtensionToolsDefer(t *testing.T) {
	const key = "ts-tool-search"
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession(key)

	host := extension.NewHost()
	for name, always := range map[string]bool{"recall": false, "write_journal": true} {
		host.SDK().RegisterTool(extension.ToolDefinition{
			Name:        name,
			Description: "test tool " + name,
			Parameters:  map[string]interface{}{},
			AlwaysLoad:  always,
			Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
				return &types.ToolResult{Content: "ok"}, nil
			},
		})
	}
	group := extension.NewExtensionGroup()
	group.Add(host)

	opts := types.RunOptions{
		Model:       "claude-sonnet-4-6",
		ClientTools: []types.ClientToolDef{{Name: "browser_click", Description: "click"}},
		ClientToolRouter: func(_ context.Context, name string, _ map[string]interface{}) *types.ToolResult {
			return &types.ToolResult{Content: name}
		},
	}
	mgr.wireToolServer(s, key, &opts, group)
	mgr.wireAgentToolServer(s, key, &opts)
	mgr.wireQuestionToolServer(s, key, &opts)
	mgr.wireClientToolServer(s, key, &opts)
	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()
	if ts == nil {
		t.Fatal("expected a ToolServer")
	}
	defer ts.Stop()

	for name, want := range map[string]bool{
		"recall":                  false,
		"write_journal":           true,
		"ion_agent":               true,
		"ion_agent_status":        true,
		tools.AskUserQuestionName: true,
		"browser_click":           true,
	} {
		if !ts.HasTool(name) {
			t.Errorf("%s is not registered", name)
			continue
		}
		if got := ts.AlwaysLoads(name); got != want {
			t.Errorf("%s always-load = %v, want %v", name, got, want)
		}
	}
}

// An engine-owned run's context breakdown counts the list tool search keeps,
// not every deferred definition.
func TestToolListAfterToolSearch_CountsWhatIsSent(t *testing.T) {
	defs := []types.LlmToolDef{{Name: "Read"}, {Name: "mcp__s__a", Deferrable: true}, {Name: "mcp__s__b", Deferrable: true}}
	got := backend.ToolListAfterToolSearch(defs, "on", "")
	var names []string
	for _, d := range got {
		names = append(names, d.Name)
	}
	if len(names) != 3 || names[0] != "Read" || names[1] != "ToolSearch" || names[2] != "ToolCall" {
		t.Errorf("kept %v", names)
	}
}
