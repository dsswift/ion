package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestFlattenEntriesCanonicalIDs pins the canonical row-id scheme
// (SessionMessage.ID): the entry id for the first row an entry produces,
// "<entryId>:<n>" for subsequent rows. Consumers key transcripts on these
// ids, so the scheme is wire contract — changing it breaks cross-client
// dedup.
func TestFlattenEntriesCanonicalIDs(t *testing.T) {
	conv := CreateConversation("ids", "s", "m")

	userEntry := AddUserMessage(conv, "run the tool")
	isErr := false
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "thinking", Thinking: "hmm"},
		{Type: "text", Text: "running it"},
		{Type: "tool_use", ID: "toolu_1", Name: "Bash", Input: map[string]any{"command": "ls"}},
	}, types.LlmUsage{})
	assistantEntry := conv.Entries[len(conv.Entries)-1]
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "toolu_1", Content: "ok", IsError: isErr}})

	msgs := flattenEntries(conv)
	if len(msgs) != 3 {
		t.Fatalf("got %d rows, want 3 (user, assistant text, tool)", len(msgs))
	}

	if msgs[0].ID != userEntry.ID {
		t.Errorf("user row id = %q, want entry id %q", msgs[0].ID, userEntry.ID)
	}
	// Thinking blocks produce no row; the text block is the entry's first row
	// (bare entry id), the tool_use its second (":1").
	if msgs[1].ID != assistantEntry.ID {
		t.Errorf("assistant text row id = %q, want %q", msgs[1].ID, assistantEntry.ID)
	}
	if msgs[2].ID != assistantEntry.ID+":1" {
		t.Errorf("tool row id = %q, want %q", msgs[2].ID, assistantEntry.ID+":1")
	}
	if msgs[2].ToolID != "toolu_1" {
		t.Errorf("tool row ToolID = %q", msgs[2].ToolID)
	}
	// The tool_result merge adds no row and no id churn.
	if msgs[2].Content != "ok" {
		t.Errorf("tool result content = %q", msgs[2].Content)
	}
	if msgs[2].IsError {
		t.Error("tool row IsError = true, want false")
	}
}

// TestFlattenEntriesToolErrorPreserved pins that a persisted tool_result
// error flag survives reload — history must not coerce failed tools to
// success (the live path renders them failed; parity requires history to
// agree).
func TestFlattenEntriesToolErrorPreserved(t *testing.T) {
	conv := CreateConversation("errs", "s", "m")
	AddUserMessage(conv, "run")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "tool_use", ID: "toolu_bad", Name: "Bash", Input: map[string]any{"command": "false"}},
	}, types.LlmUsage{})
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "toolu_bad", Content: "exit 1", IsError: true}})

	msgs := flattenEntries(conv)
	var tool *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "tool" {
			tool = &msgs[i]
		}
	}
	if tool == nil {
		t.Fatal("no tool row")
	}
	if !tool.IsError {
		t.Fatal("IsError lost on reload flatten")
	}
}

// TestFlattenEntriesMarkerRowIDs pins that marker rows (compaction, plan,
// steer) carry their entry id.
func TestFlattenEntriesMarkerRowIDs(t *testing.T) {
	conv := CreateConversation("markers", "s", "m")
	AddUserMessage(conv, "hello")
	planEntry := AppendEntry(conv, EntryPlanMarker, PlanMarkerData{Operation: "created", PlanFilePath: "/p.md", PlanSlug: "p"})
	steerEntry := AppendEntry(conv, EntrySteerMarker, SteerMarkerData{MessageLength: 7})

	msgs := flattenEntries(conv)
	if len(msgs) != 3 {
		t.Fatalf("got %d rows, want 3", len(msgs))
	}
	if msgs[1].ID != planEntry.ID || msgs[1].MarkerKind != "plan" {
		t.Errorf("plan marker row: id=%q kind=%q", msgs[1].ID, msgs[1].MarkerKind)
	}
	if msgs[2].ID != steerEntry.ID || msgs[2].MarkerKind != "steer" {
		t.Errorf("steer marker row: id=%q kind=%q", msgs[2].ID, msgs[2].MarkerKind)
	}
}
