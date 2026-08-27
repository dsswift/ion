package tools

import (
	"context"
	"strings"
	"testing"
)

func sampleAgentStatusEntries() []AgentStatusEntry {
	return []AgentStatusEntry{
		{DispatchID: "dispatch-z", Name: "reviewer", Status: "suspended", Depth: 2, WaitingOn: &AgentStatusWaitingOn{ChildDispatchIDs: []string{"dispatch-child"}}},
		{DispatchID: "dispatch-a", Name: "developer", Status: "running", Depth: 1, ToolCount: 3, LastWork: "Using Read..."},
	}
}

func TestAgentStatusListsExistingDispatchesWithoutSpawning(t *testing.T) {
	spawned := false
	ctx := WithAgentSpawner(context.Background(), func(context.Context, string, string, string, string, string) (string, error) {
		spawned = true
		return "", nil
	})
	ctx = WithAgentStatusGetter(ctx, sampleAgentStatusEntries)

	result, err := ExecuteTool(ctx, AgentStatusToolName, map[string]any{}, t.TempDir())
	if err != nil {
		t.Fatalf("AgentStatus: %v", err)
	}
	if result.IsError {
		t.Fatalf("AgentStatus returned error: %s", result.Content)
	}
	if spawned {
		t.Fatal("AgentStatus called AgentSpawner")
	}
	if first, second := strings.Index(result.Content, "dispatch-a"), strings.Index(result.Content, "dispatch-z"); first < 0 || second < 0 || first > second {
		t.Fatalf("AgentStatus result is missing stable dispatch ordering: %s", result.Content)
	}
	for _, want := range []string{`"status": "running"`, `"status": "suspended"`, `"toolCount": 3`, `"childDispatchIds"`} {
		if !strings.Contains(result.Content, want) {
			t.Errorf("AgentStatus result missing %q: %s", want, result.Content)
		}
	}
}

func TestAgentStatusFiltersByExactDispatchID(t *testing.T) {
	ctx := WithAgentStatusGetter(context.Background(), sampleAgentStatusEntries)
	result, err := ExecuteTool(ctx, AgentStatusToolName, map[string]any{"dispatch_id": "dispatch-z"}, t.TempDir())
	if err != nil {
		t.Fatalf("AgentStatus: %v", err)
	}
	if result.IsError {
		t.Fatalf("AgentStatus returned error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "dispatch-z") || strings.Contains(result.Content, "dispatch-a") {
		t.Fatalf("AgentStatus exact filter returned wrong entries: %s", result.Content)
	}
}

func TestAgentStatusEmptyAndMissingDispatch(t *testing.T) {
	ctx := WithAgentStatusGetter(context.Background(), func() []AgentStatusEntry { return []AgentStatusEntry{} })
	empty, err := ExecuteTool(ctx, AgentStatusToolName, map[string]any{}, t.TempDir())
	if err != nil {
		t.Fatalf("AgentStatus empty: %v", err)
	}
	if empty.Content != "No active agent dispatches." || empty.IsError {
		t.Fatalf("AgentStatus empty result = %#v", empty)
	}

	ctx = WithAgentStatusGetter(context.Background(), sampleAgentStatusEntries)
	missing, err := ExecuteTool(ctx, AgentStatusToolName, map[string]any{"dispatch_id": "missing"}, t.TempDir())
	if err != nil {
		t.Fatalf("AgentStatus missing: %v", err)
	}
	if missing.IsError || !strings.Contains(missing.Content, "No active agent dispatch found") {
		t.Fatalf("AgentStatus missing result = %#v", missing)
	}
}

func TestAgentStatusRejectsInvalidInputAndMissingGetter(t *testing.T) {
	invalid, err := ExecuteTool(context.Background(), AgentStatusToolName, map[string]any{"dispatch_id": 42}, t.TempDir())
	if err != nil {
		t.Fatalf("AgentStatus invalid: %v", err)
	}
	if !invalid.IsError || !strings.Contains(invalid.Content, "must be a string") {
		t.Fatalf("AgentStatus invalid result = %#v", invalid)
	}

	unavailable, err := ExecuteTool(context.Background(), AgentStatusToolName, map[string]any{}, t.TempDir())
	if err != nil {
		t.Fatalf("AgentStatus unavailable: %v", err)
	}
	if !unavailable.IsError || !strings.Contains(unavailable.Content, "unavailable") {
		t.Fatalf("AgentStatus unavailable result = %#v", unavailable)
	}
}

func TestAgentToolDescriptionSeparatesCreateFromStatus(t *testing.T) {
	description := AgentTool().Description
	if !strings.Contains(description, "Every call creates a new dispatch") || !strings.Contains(description, AgentStatusToolName) {
		t.Fatalf("Agent description does not direct status checks away from dispatch: %q", description)
	}
	if !strings.Contains(description, "Never use Poll") || !strings.Contains(AgentStatusTool().Description, "Never use Poll") {
		t.Fatalf("Agent tools do not forbid Poll as a dispatch wait primitive: Agent=%q AgentStatus=%q", description, AgentStatusTool().Description)
	}
}
