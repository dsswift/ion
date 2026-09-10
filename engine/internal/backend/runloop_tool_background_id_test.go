package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// runloop_tool_background_id_test.go pins the asynchronous-work correlation key
// across the one place a finished ToolResult becomes both a persisted row and a
// client-visible event.
//
// A tool that starts asynchronous work sets ToolResult.BackgroundTaskID: Bash
// for a run_in_background task, Agent for a dispatch, Poll for a poll. That ID
// is the ONLY thing binding a transcript tool row to the live task, and two
// consumers need it:
//
//   - the emitted ToolResultEvent, so a client can render the row as pending
//     async work and place it in its live background-work inventory;
//   - the persisted ToolResultEntry, so the binding survives a reload instead
//     of falling through to types.ParseCanonicalBashStartResult, which recovers
//     the ID by string-matching the Bash tool's own result prose.
//
// executeTools assembled the ToolResultEntry field by field and omitted this
// one, so every background task shipped with an empty key: clients marked the
// row completed the instant it started, and the live Bash group had nothing to
// match against.
//
// Revert-check: drop `BackgroundTaskID: toolResult.BackgroundTaskID` from the
// ToolResultEntry assembly in runloop_tools.go and both assertions go red.
func TestExecuteToolsPropagatesBackgroundTaskID(t *testing.T) {
	b := NewApiBackend()
	var captured []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		captured = append(captured, ev)
	})

	const wantTaskID = "bash-7-1789041447216"
	run := &activeRun{
		requestID: "bg-id",
		conv:      &conversation.Conversation{ID: "conv-bg-id"},
		cfg: &RunConfig{
			McpToolRouter: func(_ context.Context, _ string, _ map[string]interface{}) (*types.ToolResult, error) {
				return &types.ToolResult{
					Content:          "Background task started: " + wantTaskID + "\nOutput file: /tmp/out",
					BackgroundTaskID: wantTaskID,
				}, nil
			},
		},
	}

	blocks := []types.LlmContentBlock{{
		Name:  "mcp__shell__background",
		ID:    "tc-bg-1",
		Input: map[string]interface{}{"command": "make test-linux-engine"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}

	// (1) The persisted row keeps the key, so a reload binds the row to the
	// task without re-parsing the result text.
	if results[0].BackgroundTaskID != wantTaskID {
		t.Errorf("results[0].BackgroundTaskID = %q, want %q", results[0].BackgroundTaskID, wantTaskID)
	}

	// (2) The emitted event carries the key, which is what a client binds its
	// transcript tool row to the live task with.
	var tre *types.ToolResultEvent
	for _, ev := range captured {
		if d, ok := ev.Data.(*types.ToolResultEvent); ok && d.ToolID == "tc-bg-1" {
			tre = d
		}
	}
	if tre == nil {
		t.Fatal("no ToolResultEvent emitted for the tool call")
	}
	if tre.BackgroundTaskID != wantTaskID {
		t.Errorf("ToolResultEvent.BackgroundTaskID = %q, want %q", tre.BackgroundTaskID, wantTaskID)
	}
}
