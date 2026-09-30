package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

func dispatchRecord(ts int64, d conversation.AgentDispatchData) conversation.SessionEntry {
	return conversation.SessionEntry{ID: d.AgentID, Type: conversation.EntryAgentDispatch, Timestamp: ts, Data: d}
}

// TestDispatchHistoryFromConversation pins how a restarted session rebuilds
// dispatch history from persisted records: the Terminal record wins, legacy
// terminal records fall back to their timestamps with no exit code, an
// in-flight record becomes lost, and a recalled in-flight record is cancelled.
func TestDispatchHistoryFromConversation(t *testing.T) {
	exit := 1
	conv := &conversation.Conversation{Entries: []conversation.SessionEntry{
		// Registered, then finished with a Terminal record written onto both.
		dispatchRecord(1000, conversation.AgentDispatchData{AgentID: "d-err", AgentName: "worker", Status: "running", DispatchDepth: 2, DispatchParentID: "d-lead",
			Terminal: &conversation.DispatchTerminalRecord{Status: "error", Reason: "boom", ExitCode: &exit, StartedAt: 1000, CompletedAt: 4000, ToolCount: 3}}),
		dispatchRecord(4000, conversation.AgentDispatchData{AgentID: "d-err", AgentName: "worker", Status: "error", DispatchDepth: 2, DispatchParentID: "d-lead", ConversationID: "conv-err",
			Terminal: &conversation.DispatchTerminalRecord{Status: "error", Reason: "boom", ExitCode: &exit, StartedAt: 1000, CompletedAt: 4000, ToolCount: 3}}),
		// Legacy: finished before Terminal records existed.
		dispatchRecord(2000, conversation.AgentDispatchData{AgentID: "d-legacy", AgentName: "old", Status: "running", DispatchDepth: 1}),
		dispatchRecord(3000, conversation.AgentDispatchData{AgentID: "d-legacy", AgentName: "old", Status: "done", DispatchDepth: 1}),
		// In flight at engine death.
		dispatchRecord(5000, conversation.AgentDispatchData{AgentID: "d-lost", AgentName: "gone", Status: "running", DispatchDepth: 1}),
		// Recalled, but the process died before the cancelled record landed.
		dispatchRecord(6000, conversation.AgentDispatchData{AgentID: "d-recalled", AgentName: "stopped", Status: "running", DispatchDepth: 1, RecallIntent: true}),
	}}
	now := time.UnixMilli(9000)
	got := dispatchHistoryFromConversation(conv, now)

	byID := map[string]extcontext.DispatchTerminalEntry{}
	var order []string
	for _, e := range got {
		byID[e.DispatchID] = e
		order = append(order, e.DispatchID)
	}
	if want := []string{"d-legacy", "d-err", "d-recalled", "d-lost"}; len(order) != len(want) || order[0] != want[0] || order[1] != want[1] || order[2] != want[2] || order[3] != want[3] {
		t.Fatalf("completion order = %v, want %v", order, want)
	}

	errEntry := byID["d-err"]
	if errEntry.Status != "error" || errEntry.Reason != "boom" || errEntry.ExitCode == nil || *errEntry.ExitCode != 1 ||
		errEntry.ParentDispatchID != "d-lead" || errEntry.Depth != 2 || errEntry.ToolCount != 3 ||
		errEntry.ChildConversationID != "conv-err" || !errEntry.CompletedAt.Equal(time.UnixMilli(4000)) {
		t.Errorf("d-err = %+v", errEntry)
	}
	legacy := byID["d-legacy"]
	if legacy.Status != "done" || legacy.ExitCode != nil || !legacy.StartedAt.Equal(time.UnixMilli(2000)) || !legacy.CompletedAt.Equal(time.UnixMilli(3000)) {
		t.Errorf("d-legacy = %+v, want done at 3000, started 2000, no exit code", legacy)
	}
	lost := byID["d-lost"]
	if lost.Status != extcontext.DispatchStatusLost || lost.Reason != lostDispatchReason || !lost.CompletedAt.Equal(now) || lost.ExitCode != nil {
		t.Errorf("d-lost = %+v, want lost at restart time", lost)
	}
	if recalled := byID["d-recalled"]; recalled.Status != extcontext.DispatchStatusCancelled {
		t.Errorf("d-recalled = %+v, want cancelled", recalled)
	}
}

// TestDispatchControlMismatch_EmitsTelemetry pins the session wiring from the
// registry's mismatch report to the dispatch.control_mismatch telemetry
// event: a steer against this session's registry for a dispatch another
// registry holds live emits one event with both registries' identity.
func TestDispatchControlMismatch_EmitsTelemetry(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	if _, err := mgr.StartSession("mm-1", types.EngineConfig{}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.RLock()
	s := mgr.sessions["mm-1"]
	mgr.mu.RUnlock()
	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	s.telemetry = col

	other := extcontext.NewDispatchRegistry()
	other.RegisterWithID("held-elsewhere", "worker", func(string) {}, nil, "other-session", "", 1)
	t.Cleanup(func() { other.RecallAll("test cleanup") })

	if got := s.dispatchRegistry.SteerOwnedByID("", "held-elsewhere", "msg").Outcome; got != extcontext.SteerOutcomeUnauthorized {
		t.Fatalf("steer outcome = %q, want unauthorized", got)
	}
	ev := findEvent(col, telemetry.DispatchControlMismatch)
	if ev == nil {
		t.Fatal("expected a dispatch.control_mismatch event")
	}
	for key, want := range map[string]any{
		"dispatch_id": "held-elsewhere", "operation": "steer", "outcome": "unauthorized",
		"holding_session_id": "other-session", "lifecycle_state": "running",
	} {
		if ev.Payload[key] != want {
			t.Errorf("payload[%q] = %v, want %v", key, ev.Payload[key], want)
		}
	}
	if ev.Payload["resolving_registry"] == ev.Payload["holding_registry"] {
		t.Errorf("resolving and holding registry are the same: %v", ev.Payload)
	}
}
