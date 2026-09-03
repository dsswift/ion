package session

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestWireQuestionToolServer_RegistersSentinelOnClaudeCode pins that the
// AskUserQuestion sentinel is exposed on the per-session MCP ToolServer for a
// claude-code run in a non-plan run — the gap that made single-question asks
// impossible on the CLI backend. Before the fix nothing registered it there.
func TestWireQuestionToolServer_RegistersSentinelOnClaudeCode(t *testing.T) {
	// HOME is the package-wide short /tmp path from TestMain — required so the
	// tool server's Unix socket stays under the ~104-byte sun_path limit. Do
	// NOT override it with t.TempDir(); a deep temp path fails the socket bind.
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession("cliq")
	opts := types.RunOptions{}

	mgr.wireQuestionToolServer(s, "cliq", &opts)

	if s.toolServer == nil {
		t.Fatal("expected a ToolServer to be created for the claude-code question sentinel")
	}
	t.Cleanup(func() { s.toolServer.Stop() })
	if !s.toolServer.HasTool(tools.AskUserQuestionName) {
		t.Errorf("AskUserQuestion sentinel not registered on the claude-code ToolServer")
	}
}

// TestWireClientToolServer_RegistersHumanWaitOnClaudeCode pins that a human-wait
// client tool (AskUserQuestions) is now REGISTERED on claude-code rather than
// skipped. Reverting to the old `continue` skip turns this red — the exact
// regression that left multi-question asks dead on the CLI backend.
func TestWireClientToolServer_RegistersHumanWaitOnClaudeCode(t *testing.T) {
	// See the sibling test: rely on TestMain's short HOME for the socket bind.
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession("cliw")
	opts := types.RunOptions{
		ClientTools: []types.ClientToolDef{{
			Name:        tools.AskUserQuestionsName,
			HumanWait:   true,
			Description: "multi-question",
			InputSchema: map[string]any{"type": "object"},
		}},
		ClientToolRouter: func(_ context.Context, _ string, _ map[string]interface{}) *types.ToolResult {
			return &types.ToolResult{Content: "unused on claude-code"}
		},
	}

	mgr.wireClientToolServer(s, "cliw", &opts)

	if s.toolServer == nil {
		t.Fatal("expected a ToolServer to be created for the claude-code client tools")
	}
	t.Cleanup(func() { s.toolServer.Stop() })
	if !s.toolServer.HasTool(tools.AskUserQuestionsName) {
		t.Errorf("human-wait AskUserQuestions must be registered on claude-code, not skipped")
	}
}

// TestEnsureCliToolServerAttached_ReattachesReusedServer pins the turn-2 bug:
// the ToolServer is created once and reused for the session, but RunOptions are
// rebuilt every turn. The wire* helpers only set opts.McpConfig when they CREATE
// the server (needsStart), so a second turn reusing the server was spawned with
// an empty McpConfig — buildClaudeArgs then dropped --mcp-config AND the
// mcp__<server>__* allowedTools wildcard, and the CLI reported every
// ion-extensions tool as "No such tool available". ensureCliToolServerAttached
// re-attaches on every turn. Reverting the ensure call leaves opts.McpConfig
// empty here and turns this red.
func TestEnsureCliToolServerAttached_ReattachesReusedServer(t *testing.T) {
	// See the sibling tests: TestMain's short HOME is required for the socket bind.
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession("clir")

	// Turn 1 creates and attaches the session ToolServer.
	optsTurn1 := types.RunOptions{}
	mgr.wireQuestionToolServer(s, "clir", &optsTurn1)
	if s.toolServer == nil {
		t.Fatal("expected turn-1 wiring to create the session ToolServer")
	}
	t.Cleanup(func() { s.toolServer.Stop() })

	// Turn 2 reuses the same ToolServer with a FRESH RunOptions. No wire helper
	// takes the needsStart path, so nothing sets McpConfig — the ensure step must.
	optsTurn2 := types.RunOptions{}
	mgr.ensureCliToolServerAttached(s, "clir", &optsTurn2)
	if optsTurn2.McpConfig == "" {
		t.Fatal("reused ToolServer left turn-2 RunOptions with an empty McpConfig; the CLI would lose every MCP tool")
	}

	// Idempotent: a turn whose wiring already attached (McpConfig non-empty) is a
	// no-op and keeps the value it already had.
	optsAttached := types.RunOptions{McpConfig: "/already/attached.json"}
	mgr.ensureCliToolServerAttached(s, "clir", &optsAttached)
	if optsAttached.McpConfig != "/already/attached.json" {
		t.Errorf("ensure must not overwrite an already-attached McpConfig, got %q", optsAttached.McpConfig)
	}
}
