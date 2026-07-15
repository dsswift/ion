package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestTranslateConversationTurns_TaskComplete verifies that
// translateToEngineEvent stamps StatusFields.ConversationTurns from
// TaskCompleteEvent.ConversationTurns — the conversation-lifetime prompt count,
// distinct from the per-run NumTurns. This test pins that the two fields are
// carried independently: a run with few round-trips (NumTurns) can belong to a
// long conversation with many prompts (ConversationTurns). It fails on any code
// that drops ConversationTurns or aliases it to NumTurns.
func TestTranslateConversationTurns_TaskComplete(t *testing.T) {
	const wantConversationTurns = 210 // lifetime prompt count
	const wantNumTurns = 2            // per-run round-trips
	event := types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			NumTurns:          wantNumTurns,
			ConversationTurns: wantConversationTurns,
			CostUsd:           0.5,
			SessionID:         "sess-lifetime",
			Usage:             types.UsageData{},
		},
	}

	eng := translateToEngineEvent(event, 200000)

	if eng.Fields == nil {
		t.Fatal("translateToEngineEvent: expected non-nil Fields for TaskCompleteEvent")
	}
	if eng.Fields.ConversationTurns != wantConversationTurns {
		t.Errorf("Fields.ConversationTurns = %d, want %d (lifetime prompt count must carry through)", eng.Fields.ConversationTurns, wantConversationTurns)
	}
	// The per-run count must remain independent — proving the drawer can show
	// lifetime "Turns" without losing the per-run signal.
	if eng.Fields.NumTurns != wantNumTurns {
		t.Errorf("Fields.NumTurns = %d, want %d (per-run count must remain independent of ConversationTurns)", eng.Fields.NumTurns, wantNumTurns)
	}
	if eng.Fields.ConversationTurns == eng.Fields.NumTurns {
		t.Error("ConversationTurns must not be aliased to NumTurns; they are distinct counts")
	}
}

// TestTranslateConversationTurns_ZeroOmitted verifies that a zero
// ConversationTurns (e.g. the CLI/normalizer path that never loads the Ion
// tree) stays zero in StatusFields, serializing as absent via omitempty.
func TestTranslateConversationTurns_ZeroOmitted(t *testing.T) {
	event := types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			NumTurns:  3,
			SessionID: "sess-zero",
			Usage:     types.UsageData{},
		},
	}

	eng := translateToEngineEvent(event, 200000)

	if eng.Fields == nil {
		t.Fatal("expected non-nil Fields")
	}
	if eng.Fields.ConversationTurns != 0 {
		t.Errorf("Fields.ConversationTurns = %d, want 0 (unpopulated path)", eng.Fields.ConversationTurns)
	}
}
