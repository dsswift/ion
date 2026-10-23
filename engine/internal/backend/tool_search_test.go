package backend

import (
	"context"
	"encoding/json"
	"net"
	"slices"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// The CLI keeps a tool loaded under its tool search only when its tools/list
// entry carries `_meta["anthropic/alwaysLoad"] = true`; every other tool is
// deferred behind ToolSearch.
func TestToolServer_AlwaysLoadMetaMarksOnlyAlwaysLoadTools(t *testing.T) {
	ts := NewToolServer("always-load-test")
	handler := func(_ context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "ok"}, nil
	}
	ts.RegisterAlwaysLoadTool("core", handler, "Engine core tool", nil)
	ts.RegisterTool("extension", handler, "Extension tool", nil)
	defer ts.Stop()
	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	initializeSession(t, conn)

	resp := sendJSONRPC(t, conn, "tools/list", 1, nil)
	listed := resp["result"].(map[string]interface{})["tools"].([]interface{})
	meta := map[string]interface{}{}
	for _, raw := range listed {
		tool := raw.(map[string]interface{})
		meta[tool["name"].(string)] = tool["_meta"]
	}
	core, ok := meta["core"].(map[string]interface{})
	if !ok || core[AlwaysLoadMetaKey] != true {
		t.Errorf("core tool _meta = %v, want %s: true", meta["core"], AlwaysLoadMetaKey)
	}
	if meta["extension"] != nil {
		t.Errorf("a deferrable tool carries no _meta, got %v", meta["extension"])
	}
}

// The CLI keeps its own tool-search default unless a mode is configured, and
// an unparseable mode never reaches it. The engine no longer forces it off.
func TestClaudeToolSearchEnv(t *testing.T) {
	base := []string{"PATH=/bin"}
	cases := map[string]string{"": "", "garbage": "", "on": "ENABLE_TOOL_SEARCH=true", "off": "ENABLE_TOOL_SEARCH=false", "auto:5": "ENABLE_TOOL_SEARCH=auto:5"}
	for mode, want := range cases {
		got := claudeToolSearchEnv(append([]string(nil), base...), mode, "r")
		extra := strings.Join(got[len(base):], ",")
		if extra != want {
			t.Errorf("mode %q: added %q, want %q", mode, extra, want)
		}
	}
}

// ToolSearch is allowed on every CLI spawn, so a deferred tool is reachable
// even under a permission mode that honors the allowlist.
func TestBuildClaudeArgs_AllowsToolSearch(t *testing.T) {
	for _, opts := range []types.RunOptions{{}, {AllowedTools: []string{"Read"}}, {McpConfig: "/tmp/mcp.json"}} {
		args := buildClaudeArgs(opts)
		i := slices.Index(args, "--allowedTools")
		if i < 0 || !slices.Contains(strings.Split(args[i+1], ","), "ToolSearch") {
			t.Errorf("opts %+v: allowedTools %v lacks ToolSearch", opts, args)
		}
	}
}

func deferrableTools(n int) []types.LlmToolDef {
	defs := []types.LlmToolDef{{Name: "Read", Description: "built-in"}}
	for i := 0; i < n; i++ {
		defs = append(defs, types.LlmToolDef{
			Name:        "mcp__house__tool" + string(rune('a'+i%26)) + strings.Repeat("x", i/26),
			Description: "A household tool " + strings.Repeat("with a long description ", 40),
			InputSchema: map[string]any{"type": "object"},
			Deferrable:  true,
		})
	}
	return defs
}

func names(defs []types.LlmToolDef) []string {
	out := make([]string, 0, len(defs))
	for _, d := range defs {
		out = append(out, d.Name)
	}
	return out
}

func TestApplyToolSearch_Modes(t *testing.T) {
	few := deferrableTools(2)
	many := deferrableTools(400) // well over 10% of the default window

	t.Run("off loads everything", func(t *testing.T) {
		run := &activeRun{requestID: "off"}
		got := applyToolSearch(run, many, "off", "")
		if len(got) != len(many) || run.deferredTools != nil {
			t.Fatalf("off kept %d of %d, deferred %d", len(got), len(many), len(run.deferredTools))
		}
	})
	t.Run("on defers every deferrable tool", func(t *testing.T) {
		run := &activeRun{requestID: "on"}
		got := names(applyToolSearch(run, few, "on", ""))
		if !slices.Equal(got, []string{"Read", "ToolSearch", "ToolCall"}) {
			t.Fatalf("on kept %v", got)
		}
		if len(run.deferredTools) != 2 {
			t.Fatalf("deferred %d", len(run.deferredTools))
		}
	})
	t.Run("default is auto: few tools load, many defer", func(t *testing.T) {
		run := &activeRun{requestID: "auto-few"}
		if got := applyToolSearch(run, few, "", ""); len(got) != len(few) {
			t.Errorf("a small set loads upfront, kept %v", names(got))
		}
		run = &activeRun{requestID: "auto-many"}
		got := names(applyToolSearch(run, many, "", ""))
		if !slices.Equal(got, []string{"Read", "ToolSearch", "ToolCall"}) || len(run.deferredTools) != 400 {
			t.Errorf("a large set defers, kept %v deferred %d", got, len(run.deferredTools))
		}
	})
	t.Run("always-load and built-in tools are never deferred", func(t *testing.T) {
		defs := append(deferrableTools(1), types.LlmToolDef{Name: "ext_core", Description: "always"})
		run := &activeRun{requestID: "keep"}
		got := names(applyToolSearch(run, defs, "on", ""))
		if !slices.Contains(got, "ext_core") || !slices.Contains(got, "Read") {
			t.Errorf("kept %v", got)
		}
	})
}

// The deferral decision depends on the tool set and the model, never on the
// run's mode, so a planning run sends byte-identical tools (ADR-038).
func TestBuildToolDefs_ToolSearchIsModeInvariant(t *testing.T) {
	b := NewApiBackend()
	provider := &mockLlmProvider{id: "mock"}
	cfg := &RunConfig{ExternalTools: deferrableTools(3)}
	build := func(planMode bool) string {
		opts := types.RunOptions{ToolSearchMode: "on", PlanMode: planMode, PlanFilePath: "/tmp/plan.md"}
		run := &activeRun{requestID: "invariant", planMode: planMode, cfg: cfg}
		defs, _ := b.buildToolDefs(run, opts, provider)
		raw, err := json.Marshal(defs)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	auto := build(false)
	if build(true) != auto {
		t.Error("the tool list differs between plan and auto mode under tool search")
	}
	if !strings.Contains(auto, `"name":"ToolSearch"`) || strings.Contains(auto, `"name":"mcp__house__`) {
		t.Errorf("deferred tools should leave the list for ToolSearch: %s", auto)
	}
}

func TestSearchDeferredTools(t *testing.T) {
	deferred := map[string]types.LlmToolDef{
		"mcp__house__chores_add":  {Name: "mcp__house__chores_add", Description: "Add a chore", InputSchema: map[string]any{"type": "object"}},
		"mcp__house__habits_list": {Name: "mcp__house__habits_list", Description: "List habits and streaks"},
		"mcp__house__tasks_add":   {Name: "mcp__house__tasks_add", Description: "Add a task"},
	}
	read := func(input map[string]any) []string {
		res := searchDeferredTools(deferred, input)
		var out struct {
			Tools []struct {
				Name        string         `json:"name"`
				InputSchema map[string]any `json:"input_schema"`
			} `json:"tools"`
		}
		if err := json.Unmarshal([]byte(res.Content), &out); err != nil {
			return nil
		}
		var got []string
		for _, t := range out.Tools {
			got = append(got, t.Name)
		}
		return got
	}
	if got := read(map[string]any{"query": "select:mcp__house__tasks_add, nope"}); !slices.Equal(got, []string{"mcp__house__tasks_add"}) {
		t.Errorf("select: got %v", got)
	}
	if got := read(map[string]any{"query": "chores"}); len(got) == 0 || got[0] != "mcp__house__chores_add" {
		t.Errorf("keyword: got %v", got)
	}
	if got := read(map[string]any{"query": "add", "max_results": float64(1)}); len(got) != 1 {
		t.Errorf("max_results: got %v", got)
	}
	if res := searchDeferredTools(deferred, map[string]any{"query": "weather"}); !strings.Contains(res.Content, "No deferred tool matches") {
		t.Errorf("no match: %s", res.Content)
	}
}

// A ToolCall runs the deferred tool it names through the normal dispatch, so
// the router (and every check before it) sees the real tool and arguments.
func TestExecuteTools_ToolCallRoutesToTheDeferredTool(t *testing.T) {
	var gotName string
	var gotInput map[string]interface{}
	cfg := &RunConfig{McpToolRouter: func(_ context.Context, name string, input map[string]interface{}) (*types.ToolResult, error) {
		gotName, gotInput = name, input
		return &types.ToolResult{Content: "chore added"}, nil
	}}
	run := &activeRun{requestID: "toolcall", cfg: cfg, deferredTools: map[string]types.LlmToolDef{
		"mcp__house__chores_add": {Name: "mcp__house__chores_add", Deferrable: true},
	}}
	b := NewApiBackend()
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", ID: "t1", Name: toolCallName, Input: map[string]any{"name": "mcp__house__chores_add", "input": map[string]any{"title": "Gutters"}}},
		{Type: "tool_use", ID: "t2", Name: toolCallName, Input: map[string]any{"name": "mcp__house__missing"}},
	}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if gotName != "mcp__house__chores_add" || gotInput["title"] != "Gutters" {
		t.Errorf("router got %q %v", gotName, gotInput)
	}
	byID := map[string]conversation.ToolResultEntry{}
	for _, r := range results {
		byID[r.ToolUseID] = r
	}
	if byID["t1"].IsError || byID["t1"].Content != "chore added" {
		t.Errorf("t1 = %+v", byID["t1"])
	}
	if !byID["t2"].IsError || !strings.Contains(byID["t2"].Content, "not a deferred tool") {
		t.Errorf("t2 = %+v", byID["t2"])
	}
}
