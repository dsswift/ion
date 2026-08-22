package tools

import (
	"context"
	"testing"
)

func TestExecuteAgent_AsyncDispatchID(t *testing.T) {
	const rawID = "dispatch-abc-123"
	SetAgentSpawner(func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		SetDispatchID(ctx, rawID)
		return "Agent dispatched asynchronously. Dispatch ID: " + rawID + ". Continue working.", nil
	})
	defer SetAgentSpawner(nil)

	tool := AgentTool()
	result, err := tool.Execute(context.Background(), map[string]any{
		"prompt": "do something",
	}, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.BackgroundTaskID != rawID {
		t.Fatalf("BackgroundTaskID = %q, want exact dispatch ID %q", result.BackgroundTaskID, rawID)
	}
	if result.Content == rawID {
		t.Fatal("Content should be display prose, not raw dispatch ID")
	}
}

func TestExecuteAgent_ForegroundNoDispatchID(t *testing.T) {
	SetAgentSpawner(func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		return "Agent completed successfully with output.", nil
	})
	defer SetAgentSpawner(nil)

	tool := AgentTool()
	result, err := tool.Execute(context.Background(), map[string]any{
		"prompt":              "do something",
		"wait_for_completion": true,
	}, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.BackgroundTaskID != "" {
		t.Fatalf("foreground call should have empty BackgroundTaskID, got %q", result.BackgroundTaskID)
	}
}

func TestExecuteAgent_AsyncNoHolder(t *testing.T) {
	SetAgentSpawner(func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		return "Agent dispatched.", nil
	})
	defer SetAgentSpawner(nil)

	tool := AgentTool()
	result, err := tool.Execute(context.Background(), map[string]any{
		"prompt": "do something",
	}, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.BackgroundTaskID != "" {
		t.Fatalf("when spawner does not set dispatch ID, BackgroundTaskID should be empty, got %q", result.BackgroundTaskID)
	}
}
