package conversation

// markers_test.go pins the contract that conversation markers — compaction,
// plan-file-written, and steer-injection events — survive a Save → Load
// round-trip and are replayed by flattenEntries as system-role SessionMessage
// rows carrying structured Marker* payloads.
//
// Why it matters: these markers render live during a session (via
// CompactingEvent / PlanFileWrittenEvent / SteerInjectedEvent), but those
// events are NOT persisted. Before this work, flattenEntries skipped every
// non-EntryMessage entry, so the markers vanished on historical reload. Each
// test here loads through the same LoadMessages path external callers use
// (Load from disk → flattenEntries), so the JSON round-trip (data comes back
// as map[string]any) is exercised end-to-end.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// findMarker returns the first SessionMessage with the given MarkerKind, or
// nil if none is present.
func findMarker(msgs []types.SessionMessage, kind string) *types.SessionMessage {
	for i := range msgs {
		if msgs[i].MarkerKind == kind {
			return &msgs[i]
		}
	}
	return nil
}

// TestCompactionMarker_ReplayedOnLoad asserts an EntryCompaction with enriched
// data is replayed as a system-role marker row by flattenEntries after a full
// Save → Load round-trip.
//
// This test is red without the EntryCompaction case in flattenEntries: revert
// that case and the marker row disappears (findMarker returns nil), failing at
// the "expected a compaction marker row" assertion.
func TestCompactionMarker_ReplayedOnLoad(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("compaction-marker", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "first question")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "first reply"}},
		types.LlmUsage{InputTokens: 10, OutputTokens: 15})

	// Append an enriched compaction entry exactly as the runloop does.
	AppendEntry(conv, EntryCompaction, CompactionData{
		Summary:          "## Decisions\n- Use Go for the new module",
		FirstKeptEntryID: "deadbeef",
		TokensBefore:     180_000,
		MessagesBefore:   42,
		MessagesAfter:    7,
		ClearedBlocks:    3,
		Strategy:         "user",
		MicroOnly:        false,
	})
	AddUserMessage(conv, "post-compaction question")

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Load through the same path external callers use.
	msgs, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	marker := findMarker(msgs, "compaction")
	if marker == nil {
		t.Fatal("expected a compaction marker row after reload, found none")
	}

	if marker.Role != "system" {
		t.Errorf("marker Role = %q, want \"system\"", marker.Role)
	}
	if marker.Content != "[Compaction]" {
		t.Errorf("marker Content = %q, want \"[Compaction]\"", marker.Content)
	}
	// Verify the enriched fields round-tripped through JSON (map[string]any)
	// and landed on the SessionMessage.
	if marker.MarkerStrategy != "user" {
		t.Errorf("MarkerStrategy = %q, want \"user\"", marker.MarkerStrategy)
	}
	if marker.MarkerMessagesBefore != 42 {
		t.Errorf("MarkerMessagesBefore = %d, want 42", marker.MarkerMessagesBefore)
	}
	if marker.MarkerMessagesAfter != 7 {
		t.Errorf("MarkerMessagesAfter = %d, want 7", marker.MarkerMessagesAfter)
	}
	if marker.MarkerClearedBlocks != 3 {
		t.Errorf("MarkerClearedBlocks = %d, want 3", marker.MarkerClearedBlocks)
	}
	if marker.MarkerSummary == "" {
		t.Error("MarkerSummary is empty, want the compaction summary")
	}
}

// TestPlanMarker_ReplayedOnLoad asserts an EntryPlanMarker is replayed as a
// system-role marker row by flattenEntries after a Save → Load round-trip, for
// both the "created" and "updated" operations.
//
// This test is red without the EntryPlanMarker case in flattenEntries: revert
// that case and the marker row disappears (findMarker returns nil).
func TestPlanMarker_ReplayedOnLoad(t *testing.T) {
	cases := []struct {
		name string
		op   string
	}{
		{"created", "created"},
		{"updated", "updated"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()

			conv := CreateConversation("plan-marker-"+tc.op, "be helpful", "claude-3-5-sonnet")
			AddUserMessage(conv, "make a plan")
			AppendEntry(conv, EntryPlanMarker, PlanMarkerData{
				Operation:    tc.op,
				PlanFilePath: "test.md",
				PlanSlug:     "test",
			})

			if err := Save(conv, dir); err != nil {
				t.Fatalf("Save: %v", err)
			}

			msgs, err := LoadMessages(conv.ID, dir)
			if err != nil {
				t.Fatalf("LoadMessages: %v", err)
			}

			marker := findMarker(msgs, "plan")
			if marker == nil {
				t.Fatal("expected a plan marker row after reload, found none")
			}
			if marker.Role != "system" {
				t.Errorf("marker Role = %q, want \"system\"", marker.Role)
			}
			if marker.MarkerPlanOperation != tc.op {
				t.Errorf("MarkerPlanOperation = %q, want %q", marker.MarkerPlanOperation, tc.op)
			}
			if marker.MarkerPlanFilePath != "test.md" {
				t.Errorf("MarkerPlanFilePath = %q, want \"test.md\"", marker.MarkerPlanFilePath)
			}
			if marker.MarkerPlanSlug != "test" {
				t.Errorf("MarkerPlanSlug = %q, want \"test\"", marker.MarkerPlanSlug)
			}
		})
	}
}

// TestClearMarker_ReplayedOnLoad asserts an EntryCleared entry is replayed as
// a system-role marker row by flattenEntries after a Save → Load round-trip.
//
// This test is red without the EntryCleared case in flattenEntries: revert
// that case and the marker row disappears (findMarker returns nil), failing at
// the "expected a clear marker row" assertion.
func TestClearMarker_ReplayedOnLoad(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("clear-marker", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "first question")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "first reply"}},
		types.LlmUsage{InputTokens: 10, OutputTokens: 15})

	// Simulate /clear: wipe messages, append the cleared entry.
	conv.Messages = nil
	AppendEntry(conv, EntryCleared, ClearedData{})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Load through the same path external callers use.
	msgs, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	marker := findMarker(msgs, "clear")
	if marker == nil {
		t.Fatal("expected a clear marker row after reload, found none")
	}
	if marker.Role != "system" {
		t.Errorf("marker Role = %q, want \"system\"", marker.Role)
	}
	if marker.Content != "──" {
		t.Errorf("marker Content = %q, want \"──\"", marker.Content)
	}
}

// TestSteerMarker_ReplayedOnLoad asserts an EntrySteerMarker is replayed as a
// system-role marker row by flattenEntries after a Save → Load round-trip, and
// that the marker row is a DISTINCT additional row from the injected user
// message (steer markers augment the transcript, they do not replace the
// user turn).
//
// This test is red without the EntrySteerMarker case in flattenEntries: revert
// that case and the marker row disappears (findMarker returns nil).
func TestSteerMarker_ReplayedOnLoad(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("steer-marker", "be helpful", "claude-3-5-sonnet")
	// Mirror the drainSteer shape: an injected user message followed by the
	// steer marker entry.
	steerMsg := "please also handle the edge case"
	AddUserMessage(conv, steerMsg)
	AppendEntry(conv, EntrySteerMarker, SteerMarkerData{
		MessageLength: len(steerMsg),
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	msgs, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	marker := findMarker(msgs, "steer")
	if marker == nil {
		t.Fatal("expected a steer marker row after reload, found none")
	}
	if marker.Role != "system" {
		t.Errorf("marker Role = %q, want \"system\"", marker.Role)
	}
	if marker.MarkerMessageLength != len(steerMsg) {
		t.Errorf("MarkerMessageLength = %d, want %d", marker.MarkerMessageLength, len(steerMsg))
	}

	// The steer marker is an ADDITIONAL row, not a replacement: the injected
	// user message must still be present as its own user row.
	var userRow *types.SessionMessage
	for i := range msgs {
		if msgs[i].Role == "user" && msgs[i].Content == steerMsg {
			userRow = &msgs[i]
			break
		}
	}
	if userRow == nil {
		t.Fatal("expected the injected user message to remain a distinct user row")
	}
	if userRow == marker {
		t.Fatal("steer marker row and user message row must be distinct")
	}
}

