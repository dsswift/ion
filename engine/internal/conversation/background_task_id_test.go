package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestBackgroundTaskID_PersistAndFlatten(t *testing.T) {
	conv := CreateConversation("bg-task", "sess", "model")
	AddUserMessage(conv, "run in background")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "tool_use", ID: "toolu_bg", Name: "Bash", Input: map[string]any{"command": "sleep 10"}},
	}, types.LlmUsage{})
	AddToolResults(conv, []ToolResultEntry{{
		ToolUseID:        "toolu_bg",
		Content:          "Background task started: task-abc123",
		BackgroundTaskID: "task-abc123",
	}})

	msgs := flattenEntries(conv)
	var tool *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "tool" {
			tool = &msgs[i]
			break
		}
	}
	if tool == nil {
		t.Fatal("no tool-role message in flattened output")
	}
	if tool.BackgroundTaskID != "task-abc123" {
		t.Fatalf("BackgroundTaskID = %q, want %q", tool.BackgroundTaskID, "task-abc123")
	}
}

func TestBackgroundTaskID_LegacyRecoveryFromContent(t *testing.T) {
	conv := CreateConversation("legacy-bg", "sess", "model")
	AddUserMessage(conv, "run in background")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "tool_use", ID: "toolu_legacy", Name: "Bash", Input: map[string]any{"command": "sleep 60"}},
	}, types.LlmUsage{})
	AddToolResults(conv, []ToolResultEntry{{
		ToolUseID: "toolu_legacy",
		Content:   "Background task started: bash-7-1700000000\nOutput file: /tmp/bash-7.out\nCompletion will be delivered to this session when the command finishes — do not poll for it. You may continue working, start more background commands, or end your turn.",
	}})

	msgs := flattenEntries(conv)
	var tool *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "tool" {
			tool = &msgs[i]
			break
		}
	}
	if tool == nil {
		t.Fatal("no tool-role message")
	}
	if tool.BackgroundTaskID != "bash-7-1700000000" {
		t.Fatalf("BackgroundTaskID = %q, want %q", tool.BackgroundTaskID, "bash-7-1700000000")
	}
}

func TestBackgroundTaskID_LegacyCorrelatesWithBackgroundWork(t *testing.T) {
	conv := CreateConversation("legacy-correlate", "sess", "model")
	AddUserMessage(conv, "run in background")

	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "tool_use", ID: "toolu_bg", Name: "Bash", Input: map[string]any{"command": "make build"}},
	}, types.LlmUsage{})
	AddToolResults(conv, []ToolResultEntry{{
		ToolUseID: "toolu_bg",
		Content:   "Background task started: bash-3-9999\nOutput file: /tmp/bash-3.out\nRead the output file to inspect progress.",
	}})

	completionText := types.FormatBackgroundTaskCompletion(
		types.BackgroundWorkItem{ID: "bash-3-9999", Source: types.BackgroundWorkSourceBash, Status: "completed", ExitCode: 0, ElapsedMs: 5000, OutputPath: "/tmp/bash-3.out"},
		"make build", "BUILD OK", nil,
	)
	AddUserMessage(conv, completionText)
	AppendEntry(conv, EntrySteerMarker, SteerMarkerData{MessageLength: len(completionText)})

	msgs := flattenEntries(conv)
	var toolRow, completionRow *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "tool" && toolRow == nil {
			toolRow = &msgs[i]
		}
		if msgs[i].Role == "user" && msgs[i].BackgroundWork != nil {
			completionRow = &msgs[i]
		}
	}
	if toolRow == nil {
		t.Fatal("no tool row")
	}
	if completionRow == nil {
		t.Fatal("no completion row (BackgroundWork nil)")
	}
	if toolRow.BackgroundTaskID != "bash-3-9999" {
		t.Fatalf("tool BackgroundTaskID = %q", toolRow.BackgroundTaskID)
	}
	if len(completionRow.BackgroundWork.Items) == 0 || completionRow.BackgroundWork.Items[0].ID != "bash-3-9999" {
		t.Fatal("BackgroundWork item ID mismatch")
	}
	if toolRow.BackgroundTaskID != completionRow.BackgroundWork.Items[0].ID {
		t.Fatal("tool row and completion row IDs do not correlate")
	}
}

func TestBackgroundTaskID_AbsentForSyncResult(t *testing.T) {
	conv := CreateConversation("sync", "sess", "model")
	AddUserMessage(conv, "list files")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "tool_use", ID: "toolu_sync", Name: "Bash", Input: map[string]any{"command": "ls"}},
	}, types.LlmUsage{})
	AddToolResults(conv, []ToolResultEntry{{
		ToolUseID: "toolu_sync",
		Content:   "file1.txt\nfile2.txt",
	}})

	msgs := flattenEntries(conv)
	for _, m := range msgs {
		if m.Role == "tool" && m.BackgroundTaskID != "" {
			t.Fatalf("sync tool result should have empty BackgroundTaskID, got %q", m.BackgroundTaskID)
		}
	}
}
