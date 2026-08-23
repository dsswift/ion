package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestTranslateToolResult_BackgroundTaskID(t *testing.T) {
	ev := translateToEngineEvent(types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:           "toolu_1",
		Content:          "Background task started: task-xyz",
		BackgroundTaskID: "task-xyz",
	}}, 0)
	if ev.Type != "engine_tool_end" {
		t.Fatalf("Type = %q, want engine_tool_end", ev.Type)
	}
	if ev.ToolBackgroundTaskID != "task-xyz" {
		t.Fatalf("ToolBackgroundTaskID = %q, want %q", ev.ToolBackgroundTaskID, "task-xyz")
	}
}

func TestTranslateToolResult_NoBackgroundTaskID(t *testing.T) {
	ev := translateToEngineEvent(types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  "toolu_2",
		Content: "file1.txt",
	}}, 0)
	if ev.ToolBackgroundTaskID != "" {
		t.Fatalf("ToolBackgroundTaskID should be empty for sync result, got %q", ev.ToolBackgroundTaskID)
	}
}
