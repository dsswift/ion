package tools

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestMain(m *testing.M) {
	// Task tools are optional; register them for tests that expect them.
	RegisterTaskTools()
	os.Exit(m.Run())
}

// ---------------------------------------------------------------------------
// Registry Tests
// ---------------------------------------------------------------------------

func TestRegistryGetTool(t *testing.T) {
	tests := []struct {
		name   string
		expect bool
	}{
		{"Read", true},
		{"Write", true},
		{"Edit", true},
		{"Bash", true},
		{"Grep", true},
		{"Glob", true},
		{"Agent", true},
		{"WebFetch", true},
		{"WebSearch", true},
		{"TaskCreate", true},
		{"TaskList", true},
		{"TaskGet", true},
		{"TaskStop", true},
		{"NotebookEdit", true},
		{"LSP", true},
		{"Skill", true},
		{"ListMcpResources", true},
		{"ReadMcpResource", true},
		{"NonExistent", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tool := GetTool(tc.name)
			if tc.expect && tool == nil {
				t.Errorf("expected tool %q to be registered", tc.name)
			}
			if !tc.expect && tool != nil {
				t.Errorf("expected tool %q to NOT be registered", tc.name)
			}
		})
	}
}

func TestGetAllTools(t *testing.T) {
	all := GetAllTools()
	if len(all) != 18 {
		t.Errorf("expected 18 tools, got %d", len(all))
	}
}

func TestGetToolDefs(t *testing.T) {
	defs := GetToolDefs()
	if len(defs) != 18 {
		t.Errorf("expected 18 tool defs, got %d", len(defs))
	}
	for _, d := range defs {
		if d.Name == "" {
			t.Error("tool def has empty name")
		}
		if d.Description == "" {
			t.Errorf("tool %q has empty description", d.Name)
		}
		if d.InputSchema == nil {
			t.Errorf("tool %q has nil input schema", d.Name)
		}
	}
}

func TestGetToolDefsHaveInputSchemaType(t *testing.T) {
	defs := GetToolDefs()
	for _, d := range defs {
		if d.InputSchema["type"] != "object" {
			t.Errorf("tool %q input schema type is %v, want \"object\"", d.Name, d.InputSchema["type"])
		}
	}
}

func TestExecuteToolUnknown(t *testing.T) {
	result, err := ExecuteTool(context.Background(), "NoSuchTool", nil, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error result for unknown tool")
	}
	if !strings.Contains(result.Content, "Unknown tool") {
		t.Errorf("expected 'Unknown tool' message, got %q", result.Content)
	}
}

func TestRegisterCustomTool(t *testing.T) {
	custom := &types.ToolDef{
		Name:        "CustomTest",
		Description: "A test tool",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "custom result"}, nil
		},
	}
	RegisterTool(custom)
	defer func() {
		mu.Lock()
		delete(registry, "CustomTest")
		mu.Unlock()
	}()

	got := GetTool("CustomTest")
	if got == nil {
		t.Fatal("custom tool not found after registration")
	}
	result, err := got.Execute(context.Background(), nil, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != "custom result" {
		t.Errorf("expected 'custom result', got %q", result.Content)
	}
}

func TestUnregisterTool(t *testing.T) {
	custom := &types.ToolDef{
		Name:        "TempTool",
		Description: "temporary",
		InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "ok"}, nil
		},
	}
	RegisterTool(custom)
	if GetTool("TempTool") == nil {
		t.Fatal("tool should exist after register")
	}
	UnregisterTool("TempTool")
	if GetTool("TempTool") != nil {
		t.Error("tool should not exist after unregister")
	}
}

func TestRegisterToolOverwrite(t *testing.T) {
	name := "OverwriteTest"
	defer func() {
		mu.Lock()
		delete(registry, name)
		mu.Unlock()
	}()

	RegisterTool(&types.ToolDef{
		Name: name, Description: "v1", InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "v1"}, nil
		},
	})
	RegisterTool(&types.ToolDef{
		Name: name, Description: "v2", InputSchema: map[string]any{"type": "object"},
		Execute: func(_ context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "v2"}, nil
		},
	})

	result, _ := ExecuteTool(context.Background(), name, nil, "/tmp")
	if result.Content != "v2" {
		t.Errorf("expected overwritten tool to return 'v2', got %q", result.Content)
	}
}
