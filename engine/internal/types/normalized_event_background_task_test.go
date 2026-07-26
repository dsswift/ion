package types

import (
	"encoding/json"
	"testing"
)

// normalized_event_background_task_test.go pins the wire shape of the
// background-task completion event and the additive TaskSuspendEvent field.
// These cross a language boundary (Go → JSON → TS/Swift), so a struct-equality
// test would not protect the consumer contract; these assert the serialized
// JSON.

// The completion event round-trips through the NormalizedEvent decode switch
// with every field intact.
func TestBackgroundTaskCompleteEvent_RoundTrip(t *testing.T) {
	original := NormalizedEvent{Data: &BackgroundTaskCompleteEvent{
		TaskID:           "bash-1-1700000000000",
		Status:           "failed",
		ExitCode:         2,
		ElapsedMs:        4200,
		OutputPath:       "/tmp/bash-1.out",
		Tail:             "compile error",
		Command:          "make build",
		RemainingTaskIDs: []string{"bash-2", "bash-3"},
	}}

	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded NormalizedEvent
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	got, ok := decoded.Data.(*BackgroundTaskCompleteEvent)
	if !ok {
		t.Fatalf("decoded to %T, want *BackgroundTaskCompleteEvent — the decode switch is missing the variant", decoded.Data)
	}
	if got.TaskID != "bash-1-1700000000000" {
		t.Errorf("TaskID = %q", got.TaskID)
	}
	if got.Status != "failed" || got.ExitCode != 2 {
		t.Errorf("Status/ExitCode = %q/%d, want failed/2", got.Status, got.ExitCode)
	}
	if got.ElapsedMs != 4200 {
		t.Errorf("ElapsedMs = %d, want 4200", got.ElapsedMs)
	}
	if got.Command != "make build" || got.Tail != "compile error" {
		t.Errorf("Command/Tail = %q/%q", got.Command, got.Tail)
	}
	if len(got.RemainingTaskIDs) != 2 {
		t.Errorf("RemainingTaskIDs = %v, want 2 entries", got.RemainingTaskIDs)
	}
}

// The serialized field names are the cross-language contract; pin them
// explicitly so a rename cannot slip past a Go-only equality check.
func TestBackgroundTaskCompleteEvent_WireFieldNames(t *testing.T) {
	raw, err := json.Marshal(&BackgroundTaskCompleteEvent{
		TaskID: "bash-1", Status: "completed", ExitCode: 0, ElapsedMs: 10,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, want := range []string{"taskId", "status", "exitCode", "elapsedMs"} {
		if _, ok := m[want]; !ok {
			t.Errorf("wire payload missing required field %q; got %v", want, m)
		}
	}
	// Optional fields must be omitted when empty so consumers can distinguish
	// "no remaining work" from "field absent".
	if _, ok := m["remainingTaskIds"]; ok {
		t.Error("remainingTaskIds should be omitted when empty")
	}
}

// TaskSuspendEvent gained AwaitingTaskIDs additively: the new field
// round-trips, and a payload written before the field existed still decodes.
func TestTaskSuspendEvent_AwaitingTaskIDsIsAdditive(t *testing.T) {
	t.Run("new field round-trips", func(t *testing.T) {
		raw, err := json.Marshal(NormalizedEvent{Data: &TaskSuspendEvent{
			AwaitingTaskIDs: []string{"bash-1", "bash-2"},
		}})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var decoded NormalizedEvent
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		got := decoded.Data.(*TaskSuspendEvent)
		if len(got.AwaitingTaskIDs) != 2 {
			t.Errorf("AwaitingTaskIDs = %v, want 2 entries", got.AwaitingTaskIDs)
		}
	})

	t.Run("old payload without the field still decodes", func(t *testing.T) {
		// Exactly what a pre-change producer emitted: the variant's fields are
		// flat on the envelope, with "type" injected alongside them.
		old := `{"type":"task_suspend","awaitingDispatchIds":["agent-1"]}`
		var decoded NormalizedEvent
		if err := json.Unmarshal([]byte(old), &decoded); err != nil {
			t.Fatalf("an old-shape payload must still decode: %v", err)
		}
		got, ok := decoded.Data.(*TaskSuspendEvent)
		if !ok {
			t.Fatalf("decoded to %T, want *TaskSuspendEvent", decoded.Data)
		}
		if len(got.AwaitingDispatchIDs) != 1 || got.AwaitingDispatchIDs[0] != "agent-1" {
			t.Errorf("AwaitingDispatchIDs = %v, want [agent-1]", got.AwaitingDispatchIDs)
		}
		if len(got.AwaitingTaskIDs) != 0 {
			t.Errorf("AwaitingTaskIDs = %v, want empty for an old payload", got.AwaitingTaskIDs)
		}
	})

	t.Run("dispatch-only suspend omits the new field", func(t *testing.T) {
		raw, err := json.Marshal(&TaskSuspendEvent{AwaitingDispatchIDs: []string{"agent-1"}})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, ok := m["awaitingTaskIds"]; ok {
			t.Error("awaitingTaskIds should be omitted for a dispatch-only suspend")
		}
	})
}

// StatusFields.BackgroundShells is the shell counterpart to BackgroundAgents
// and must be omitted when zero so existing consumers see no change.
func TestStatusFields_BackgroundShells(t *testing.T) {
	t.Run("present when non-zero", func(t *testing.T) {
		raw, err := json.Marshal(&StatusFields{BackgroundShells: 3})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got, ok := m["backgroundShells"]; !ok || got.(float64) != 3 {
			t.Errorf("backgroundShells = %v (present=%v), want 3", got, ok)
		}
	})

	t.Run("omitted when zero", func(t *testing.T) {
		raw, err := json.Marshal(&StatusFields{})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, ok := m["backgroundShells"]; ok {
			t.Error("backgroundShells should be omitted when zero")
		}
	})
}

// The config block resolves unset fields to compiled defaults, including on a
// nil receiver (engine.json omitting the block entirely).
func TestBackgroundTasksConfig_Resolved(t *testing.T) {
	t.Run("nil resolves to defaults", func(t *testing.T) {
		var cfg *BackgroundTasksConfig
		got := cfg.Resolved()
		if got.Delivery != BackgroundDeliveryWake {
			t.Errorf("Delivery = %q, want %q", got.Delivery, BackgroundDeliveryWake)
		}
		if got.MaxOutstandingPerSession <= 0 || got.ParkTimeoutMs <= 0 {
			t.Errorf("defaults must be positive, got %+v", got)
		}
	})

	t.Run("explicit values win", func(t *testing.T) {
		cfg := &BackgroundTasksConfig{
			Delivery:                 BackgroundDeliveryQueue,
			MaxOutstandingPerSession: 5,
			ParkTimeoutMs:            1000,
		}
		got := cfg.Resolved()
		if got.Delivery != BackgroundDeliveryQueue || got.MaxOutstandingPerSession != 5 || got.ParkTimeoutMs != 1000 {
			t.Errorf("Resolved() = %+v, want the explicit values preserved", got)
		}
	})

	t.Run("unrecognized delivery falls back to the default", func(t *testing.T) {
		cfg := &BackgroundTasksConfig{Delivery: "nonsense"}
		if got := cfg.Resolved(); got.Delivery != BackgroundDeliveryWake {
			t.Errorf("Delivery = %q, want the default for an unrecognized value", got.Delivery)
		}
	})
}
