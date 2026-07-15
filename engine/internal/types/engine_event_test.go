package types

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestEngineScheduleMissedWireShape pins the engine_schedule_missed
// event serialization: asyncMissedSlot and asyncHadMarker must be
// present when set, and omitted when zero-valued.
func TestEngineScheduleMissedWireShape(t *testing.T) {
	// With values set.
	ev := EngineEvent{
		Type:            "engine_schedule_missed",
		AsyncKind:       "schedule",
		AsyncID:         "daily-briefing",
		AsyncMissedSlot: "2026-05-25T09:30:00Z",
		AsyncHadMarker:  true,
	}
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(data)
	if !strings.Contains(s, `"asyncMissedSlot":"2026-05-25T09:30:00Z"`) {
		t.Errorf("expected asyncMissedSlot in output: %s", s)
	}
	if !strings.Contains(s, `"asyncHadMarker":true`) {
		t.Errorf("expected asyncHadMarker:true in output: %s", s)
	}

	// With zero values (omitempty should omit both).
	ev2 := EngineEvent{
		Type:      "engine_schedule_fired",
		AsyncKind: "schedule",
		AsyncID:   "daily-briefing",
	}
	data2, err := json.Marshal(ev2)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s2 := string(data2)
	if strings.Contains(s2, "asyncMissedSlot") {
		t.Errorf("asyncMissedSlot should be omitted when empty: %s", s2)
	}
	if strings.Contains(s2, "asyncHadMarker") {
		t.Errorf("asyncHadMarker should be omitted when false: %s", s2)
	}
}
