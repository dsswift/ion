package normalizer

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// background_task_id_test.go pins the asynchronous-work correlation key across
// a DELEGATED backend.
//
// A background Bash command or a Poll starts inside the engine, but under a
// delegated CLI backend its result leaves over MCP, passes through the CLI, and
// returns on the CLI's own stream. Neither hop has a field for an Ion task ID:
// the MCP response carries no Ion metadata and the CLI's tool_result block
// carries only tool_use_id, content, and is_error. So unlike the engine's own
// runloop -- where the value rides types.ToolResult.BackgroundTaskID straight
// through -- this path has to decode the ID back out of the engine's own
// canonical start-result text.
//
// Without it the tool row loses its only link to the live task: clients mark it
// completed the instant it starts, and the live background-Bash inventory has
// nothing to match, while the engine is still holding the session open for a
// command the transcript says already finished.
//
// Revert-check: drop the ParseCanonicalAsyncStartResult call in normalizeUser
// and the first two subtests go red.
func TestNormalizeUserRecoversAsyncStartID(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "background bash start",
			content: "Background task started: bash-1-1789044057822\nOutput file: /Users/x/.ion/tasks/bash-3979104523.out\nCompletion will be delivered to this session when the command finishes.",
			want:    "bash-1-1789044057822",
		},
		{
			name:    "poll start",
			content: "Poll started: poll-4-1789044057822\nThe engine will retry only while external work is advancing.",
			want:    "poll-4-1789044057822",
		},
		{
			// Built through the producer, not a copied literal: the point of
			// the pairing in types is that a reworded announcement fails here
			// instead of silently ceasing to parse in production.
			name:    "asynchronous agent dispatch",
			content: types.FormatCanonicalDispatchStart("dispatch-agent-2-1789044109138-097110fdb688"),
			want:    "dispatch-agent-2-1789044109138-097110fdb688",
		},
		{
			// A SYNCHRONOUS dispatch returns the child's own output. Nothing to
			// recover, and nothing to correlate: it is already finished.
			name:    "synchronous agent output is not an async start",
			content: "Agent dispatched asynchronously. Dispatch ID: but the sentence never continues the template",
			want:    "",
		},
		{
			name:    "ordinary tool output is not an async start",
			content: "Background task started: but no output-file line follows",
			want:    "",
		},
		{
			name:    "plain command output",
			content: "ok\tgithub.com/dsswift/ion/engine/internal/tools\t4.377s",
			want:    "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			inner, err := json.Marshal(c.content)
			if err != nil {
				t.Fatalf("marshal content: %v", err)
			}
			raw := json.RawMessage(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_bg_1","content":` + string(inner) + `,"is_error":false}]}}`)

			events := Normalize(raw)
			if len(events) != 1 {
				t.Fatalf("expected 1 event, got %d", len(events))
			}
			tre, ok := events[0].Data.(*types.ToolResultEvent)
			if !ok {
				t.Fatalf("expected ToolResultEvent, got %T", events[0].Data)
			}
			if tre.ToolID != "toolu_bg_1" {
				t.Errorf("ToolID = %q, want toolu_bg_1", tre.ToolID)
			}
			if tre.Content != c.content {
				t.Errorf("Content was altered by the recovery: %q", tre.Content)
			}
			if tre.BackgroundTaskID != c.want {
				t.Errorf("BackgroundTaskID = %q, want %q", tre.BackgroundTaskID, c.want)
			}
		})
	}
}
