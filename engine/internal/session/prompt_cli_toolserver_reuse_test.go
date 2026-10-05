package session

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// wirePromptTools runs the tool wiring one prompt performs on a delegated CLI
// session, in dispatch order, and returns the alias directive it produced.
func wirePromptTools(mgr *Manager, s *engineSession, key string, extNames, clientNames []string, marker string) string {
	opts := types.RunOptions{}
	for _, name := range clientNames {
		opts.ClientTools = append(opts.ClientTools, types.ClientToolDef{Name: name, Description: name})
	}
	opts.ClientToolRouter = func(_ context.Context, name string, _ map[string]interface{}) *types.ToolResult {
		return &types.ToolResult{Content: marker + ":" + name}
	}
	mgr.resetCliToolServer(s, &opts)
	mgr.wireToolServer(s, key, &opts, newToolExtGroup(extNames))
	mgr.wireClientToolServer(s, key, &opts)
	return opts.AppendSystemPrompt
}

// TestCliToolServer_SecondPromptKeepsEveryTool is the regression test for a
// session whose ToolServer outlives a prompt. Each prompt registers its tools
// on the same server. Without a reset, the second prompt found its own client
// tools already registered, took them for collisions with an earlier
// registration, and skipped them: their aliases dropped out of the system
// prompt (which rewrote the provider cache) and their handlers stayed bound to
// the first prompt's router.
//
// Revert-check: remove resetCliToolServer from wirePromptTools and the second
// directive loses the client tools.
func TestCliToolServer_SecondPromptKeepsEveryTool(t *testing.T) {
	const key = "ts-reuse-client"
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession(key)
	ext := []string{"dispatch_agent", "recall_agent"}
	client := []string{"browser_click", "browser_type"}

	first := wirePromptTools(mgr, s, key, ext, client, "first")
	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()
	if ts == nil {
		t.Fatal("expected a ToolServer after the first prompt")
	}
	defer ts.Stop()

	second := wirePromptTools(mgr, s, key, ext, client, "second")
	mgr.mu.Lock()
	again := s.toolServer
	mgr.mu.Unlock()
	if again != ts {
		t.Fatal("the session's ToolServer was replaced")
	}
	if first != second {
		t.Fatalf("the alias directive changed between two identical prompts:\nfirst  %q\nsecond %q", first, second)
	}
	for _, name := range append(ext, client...) {
		if !strings.Contains(second, name+" = mcp__") {
			t.Errorf("second prompt lost the alias for %s", name)
		}
	}

	// The handler must be this prompt's, not the first prompt's.
	res, ok, err := ts.InvokeTool(context.Background(), "browser_click", map[string]interface{}{})
	if err != nil || !ok {
		t.Fatalf("InvokeTool: ok=%v err=%v", ok, err)
	}
	if res.Content != "second:browser_click" {
		t.Fatalf("client tool is routed by a stale prompt: %q", res.Content)
	}
}

// A tool a later prompt no longer offers is gone from the server.
func TestCliToolServer_DroppedToolIsRemoved(t *testing.T) {
	const key = "ts-reuse-drop"
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession(key)

	wirePromptTools(mgr, s, key, []string{"dispatch_agent"}, []string{"browser_click", "browser_type"}, "first")
	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()
	defer ts.Stop()

	second := wirePromptTools(mgr, s, key, []string{"dispatch_agent"}, []string{"browser_click"}, "second")
	if ts.HasTool("browser_type") {
		t.Error("a client tool the prompt no longer offers is still registered")
	}
	if strings.Contains(second, "browser_type") {
		t.Errorf("a dropped tool is still in the alias directive: %q", second)
	}
	if !ts.HasTool("browser_click") || !ts.HasTool("dispatch_agent") {
		t.Error("tools the prompt still offers must stay registered")
	}
}

// The directive lists names in sorted order, so its text does not depend on
// the order the tools were reported in.
func TestBuildToolAliasDirective_OrderIndependent(t *testing.T) {
	a := buildToolAliasDirective([]string{"zeta", "alpha", "mid"}, backend.McpServerName)
	b := buildToolAliasDirective([]string{"mid", "zeta", "alpha"}, backend.McpServerName)
	if a != b {
		t.Fatalf("directive depends on input order:\n%q\n%q", a, b)
	}
	if strings.Index(a, "alpha") > strings.Index(a, "mid") || strings.Index(a, "mid") > strings.Index(a, "zeta") {
		t.Fatalf("directive is not sorted: %q", a)
	}
}
