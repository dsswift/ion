package normalizer

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestToolResultOutcome_ClaudeCodeRealUserEvent exercises the real Claude
// Code "user" event -> ToolResultEvent translation (normalizeUser, reached
// through the exported Normalize entry point), then derives the outcome
// with telemetry.ToolResultOutcome from what that path actually produces.
//
// Finding for child 06 section 5: Claude Code's tool_result content is the
// CLI's OWN text, forwarded verbatim -- Ion's ApiBackend-only "Permission
// denied: "/"Blocked: "/"Sandbox blocked: " prefix convention (see
// conversation_emitter.go's ToolResultOutcome doc) is never applied to it.
// A denial surfaced by the Claude Code CLI itself therefore falls through to
// OutcomeError here, exactly like any other execution failure, unless the
// CLI's own phrasing happens to start with one of those exact prefixes
// (unverified, and not something Ion controls). No code change was made for
// this backend's tool-outcome mapping; this test pins the verified behavior
// of the existing normalizeUser path.
func TestToolResultOutcome_ClaudeCodeRealUserEvent(t *testing.T) {
	cases := []struct {
		name    string
		isError bool
		content string
		want    string
	}{
		{"success", false, "file written", telemetry.OutcomeSuccess},
		{"cli-phrased denial (no Ion prefix)", true, "The user doesn't want to proceed with this tool use.", telemetry.OutcomeError},
		{"generic execution error", true, "command exited with status 1", telemetry.OutcomeError},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw := buildClaudeCodeUserEvent(t, "tu-1", c.content, c.isError)
			events := Normalize(raw)
			if len(events) != 1 {
				t.Fatalf("expected exactly 1 event, got %d", len(events))
			}
			tr, ok := events[0].Data.(*types.ToolResultEvent)
			if !ok {
				t.Fatalf("expected *types.ToolResultEvent, got %T", events[0].Data)
			}
			if tr.ToolID != "tu-1" {
				t.Errorf("ToolID = %q, want tu-1", tr.ToolID)
			}
			got := telemetry.ToolResultOutcome(tr.IsError, tr.Content)
			if got != c.want {
				t.Errorf("ToolResultOutcome(IsError=%v, Content=%q) = %q, want %q", tr.IsError, tr.Content, got, c.want)
			}
		})
	}
}

// buildClaudeCodeUserEvent constructs a raw NDJSON "user" event in the shape
// the Claude Code CLI emits for a completed tool_result, matching what
// normalizeUser (normalizer.go) parses.
func buildClaudeCodeUserEvent(t *testing.T, toolUseID, content string, isError bool) json.RawMessage {
	t.Helper()
	block := map[string]any{
		"type":        "tool_result",
		"tool_use_id": toolUseID,
		"content":     content,
		"is_error":    isError,
	}
	payload := map[string]any{
		"type": "user",
		"message": map[string]any{
			"content": []any{block},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}
