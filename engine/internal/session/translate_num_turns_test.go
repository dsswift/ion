package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestTranslateNumTurns_TaskComplete verifies that translateToEngineEvent
// stamps StatusFields.NumTurns from TaskCompleteEvent.NumTurns. Before WS1,
// StatusFields had no NumTurns field and the desktop hardcoded 1; this test
// must fail on that old code path.
func TestTranslateNumTurns_TaskComplete(t *testing.T) {
	const wantTurns = 7
	event := types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			NumTurns:  wantTurns,
			CostUsd:   0.5,
			SessionID: "sess-1",
			Usage:     types.UsageData{},
		},
	}

	eng := translateToEngineEvent(event, 200000)

	if eng.Fields == nil {
		t.Fatal("translateToEngineEvent: expected non-nil Fields for TaskCompleteEvent")
	}
	if eng.Fields.NumTurns != wantTurns {
		t.Errorf("Fields.NumTurns = %d, want %d (was absent/zero before WS1)", eng.Fields.NumTurns, wantTurns)
	}
	if eng.Type != "engine_status" {
		t.Errorf("Type = %q, want engine_status", eng.Type)
	}
}

// TestTranslateNumTurns_ZeroOnNoTurns verifies that a zero NumTurns on the
// TaskCompleteEvent produces a zero (omitted) NumTurns in StatusFields.
func TestTranslateNumTurns_ZeroOnNoTurns(t *testing.T) {
	event := types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			NumTurns:  0,
			CostUsd:   0.1,
			SessionID: "sess-2",
			Usage:     types.UsageData{},
		},
	}

	eng := translateToEngineEvent(event, 200000)

	if eng.Fields == nil {
		t.Fatal("expected non-nil Fields")
	}
	// NumTurns==0 means the field is zero-value, which with omitempty omits it
	// from JSON. The in-memory value should still be zero.
	if eng.Fields.NumTurns != 0 {
		t.Errorf("Fields.NumTurns = %d, want 0", eng.Fields.NumTurns)
	}
}

// TestTranslateNumTurns_IdleDoesNotCarry verifies that non-TaskComplete events
// (e.g. UsageEvent → engine_message_end) do not produce a StatusFields with
// a non-zero NumTurns — those events have no run turn count.
func TestTranslateNumTurns_IdleDoesNotCarry(t *testing.T) {
	inputTokens := 1000
	inputTokensPtr := &inputTokens
	usageEvent := types.NormalizedEvent{
		Data: &types.UsageEvent{
			Usage: types.UsageData{InputTokens: inputTokensPtr},
		},
	}
	eng := translateToEngineEvent(usageEvent, 200000)
	// UsageEvent maps to engine_message_end, not engine_status — no Fields at all.
	if eng.Fields != nil && eng.Fields.NumTurns != 0 {
		t.Errorf("UsageEvent: Fields.NumTurns = %d, want 0", eng.Fields.NumTurns)
	}
}
