package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestAppendAbortMarker_DurableAndIdempotent pins the storage contract for a
// cancelled run:
//
//   - the typed aborted entry survives Save → Load with its payload intact,
//   - the same run recorded twice yields one entry, not two,
//   - historical client reload is unchanged (the marker is telemetry, not a
//     scrollback row), and provider-visible context is unchanged.
//
// Revert bar: without AppendAbortMarker the entry is absent and the first
// assertion goes red — a cancelled run is indistinguishable on disk from a
// completed one, which is exactly the fact the engine used to discard.
func TestAppendAbortMarker_DurableAndIdempotent(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())

	const conversationID = "abort-marker-test"
	conv := CreateConversation(conversationID, "system", "model")
	AddUserMessage(conv, "do a long thing")
	AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: "starting"}}, "test-model")
	if err := Save(conv, ""); err != nil {
		t.Fatalf("initial Save: %v", err)
	}
	messagesBefore := len(conv.Messages)

	data := AbortedData{RunID: "run-1", Source: AbortSourceUser, Scope: "orchestrator", Signal: "cancelled"}
	if err := AppendAbortMarker(conversationID, data); err != nil {
		t.Fatalf("AppendAbortMarker: %v", err)
	}
	// A run exit can be delivered twice; one stop must stay one stop.
	if err := AppendAbortMarker(conversationID, data); err != nil {
		t.Fatalf("AppendAbortMarker repeat: %v", err)
	}

	loaded, err := Load(conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var count int
	for _, entry := range loaded.Entries {
		if entry.Type != EntryAborted {
			continue
		}
		count++
		got := asAbortedData(entry.Data)
		if got == nil {
			t.Fatal("aborted entry did not decode")
		}
		if *got != data {
			t.Fatalf("aborted data = %+v, want %+v", *got, data)
		}
		if entry.Timestamp == 0 {
			t.Error("aborted entry carries no timestamp — the marker's only record of when the stop happened")
		}
	}
	if count != 1 {
		t.Fatalf("aborted entries = %d, want 1", count)
	}

	// The marker must not leak into either consumer surface: flattenEntries
	// (client scrollback) has no arm for it, and the LLM context path ignores it.
	rows, err := LoadMessages(conversationID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	for _, row := range rows {
		if row.MarkerKind == "abort" {
			t.Fatal("abort marker replayed as a scrollback row — it is telemetry, not a divider")
		}
	}
	if got := len(loaded.Messages); got != messagesBefore {
		t.Fatalf("provider-visible messages = %d, want %d — the marker entered LLM context", got, messagesBefore)
	}
}

// TestAppendAbortMarker_RejectsIncompleteInput pins the required fields. A
// marker with no run id cannot be deduplicated, and one with no source cannot
// tell an operator stop from an engine cancel — both make the record useless
// to the consumer it exists for.
func TestAppendAbortMarker_RejectsIncompleteInput(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())

	cases := map[string]struct {
		conversationID string
		data           AbortedData
	}{
		"no conversation": {"", AbortedData{RunID: "r", Source: AbortSourceUser}},
		"no run id":       {"c", AbortedData{Source: AbortSourceUser}},
		"no source":       {"c", AbortedData{RunID: "r"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if err := AppendAbortMarker(tc.conversationID, tc.data); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}
