package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/workspaces"
)

func TestWorkspaceAttributionToolDefinition(t *testing.T) {
	tool := WorkspaceAttributionTool()
	if tool.Name != WorkspaceAttributionName {
		t.Fatalf("name = %q", tool.Name)
	}
	if !tool.PlanModeSafe {
		t.Fatal("workspace attribution must remain available in plan mode")
	}
	def := findToolDef(t, WorkspaceAttributionName)
	if !def.PlanModeSafe {
		t.Fatal("registry dropped plan-mode-safe metadata")
	}
}

func TestWorkspaceAttributionToolValidatesLines(t *testing.T) {
	result, err := executeWorkspaceAttribution(context.Background(), map[string]any{
		"file": "x.go", "endLine": float64(3),
	}, t.TempDir())
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !result.IsError {
		t.Fatalf("result = %#v, want input error", result)
	}
}

func TestWorkspaceAttributionToolRejectsOutsideBench(t *testing.T) {
	dir := t.TempDir()
	t.Cleanup(workspaces.SetSharedCheckerForTest(workspaces.NewCheckerAt(dir)))
	result, err := executeWorkspaceAttribution(context.Background(), map[string]any{"file": "x.go"}, dir)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !result.IsError {
		t.Fatalf("result = %#v, want outside-bench error", result)
	}
	var decoded workspaces.AttributionResult
	if err := json.Unmarshal([]byte(result.Content), &decoded); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if decoded.Rejection == "" {
		t.Fatal("missing rejection")
	}
}

func TestWorkspaceAttributionToolReturnsSourceResult(t *testing.T) {
	dir := t.TempDir()
	bench := filepath.Join(dir, "bench")
	if err := os.MkdirAll(bench, 0o755); err != nil {
		t.Fatal(err)
	}
	record := `{"workspaces":[{"repoPath":"/repo","sourceBranch":"main","benchPath":` + quoteJSON(bench) + `,"baseSha":"base","members":[]}]}`
	if err := os.WriteFile(filepath.Join(dir, "integration-workspaces.json"), []byte(record), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(workspaces.SetSharedCheckerForTest(workspaces.NewCheckerAt(dir)))
	result, err := executeWorkspaceAttribution(context.Background(), map[string]any{"file": "missing.go"}, bench)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected tool error: %s", result.Content)
	}
	var decoded workspaces.AttributionResult
	if err := json.Unmarshal([]byte(result.Content), &decoded); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if decoded.Outcome != workspaces.OutcomeSource {
		t.Fatalf("outcome = %q, want source", decoded.Outcome)
	}
}

func findToolDef(t *testing.T, name string) struct {
	Name         string
	PlanModeSafe bool
} {
	t.Helper()
	for _, def := range GetToolDefs() {
		if def.Name == name {
			return struct {
				Name         string
				PlanModeSafe bool
			}{def.Name, def.PlanModeSafe}
		}
	}
	t.Fatalf("tool definition %q not found", name)
	return struct {
		Name         string
		PlanModeSafe bool
	}{}
}

func quoteJSON(value string) string {
	raw, _ := json.Marshal(value) //nolint:errcheck // strings always marshal
	return string(raw)
}
