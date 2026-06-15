package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestPlanProposalExit_MarksPlanModeExited verifies that a
// PlanProposalEvent{Kind:"exit"} flowing through handleNormalizedEvent
// records the plan-mode exit on the session (hasExitedPlanMode=true), so
// re-entering plan mode later triggers reentry detection in SendPrompt.
//
// Background: per ADR-003 the model calling ExitPlanMode surfaces as a
// PlanProposalEvent (workflow proposal), not a
// PlanModeChangedEvent{Enabled:false} (state change). The CLI backend was
// migrated to emit the proposal event; this test pins the manager-side
// reentry wiring that previously keyed only off the now-removed
// PlanModeChangedEvent{Enabled:false}.
func TestPlanProposalExit_MarksPlanModeExited(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("pp-exit", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["pp-exit"]
	s.requestID = "run-pp-exit"
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-pp-exit", types.NormalizedEvent{
		Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: "/tmp/ion/plans/brave-sailing-otter.md",
		},
	})

	mgr.mu.RLock()
	got := s.hasExitedPlanMode
	mgr.mu.RUnlock()
	if !got {
		t.Error("expected hasExitedPlanMode=true after PlanProposalEvent{Kind:\"exit\"}")
	}
}

// TestPlanProposalNonExit_DoesNotMarkExited verifies that a non-"exit"
// proposal kind does not flip the reentry flag (forward-compat: unknown
// kinds like "enter"/"amend" must not be treated as exits).
func TestPlanProposalNonExit_DoesNotMarkExited(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("pp-enter", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["pp-enter"]
	s.requestID = "run-pp-enter"
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-pp-enter", types.NormalizedEvent{
		Data: &types.PlanProposalEvent{
			Kind:         "enter",
			PlanFilePath: "/tmp/ion/plans/brave-sailing-otter.md",
		},
	})

	mgr.mu.RLock()
	got := s.hasExitedPlanMode
	mgr.mu.RUnlock()
	if got {
		t.Error("hasExitedPlanMode must stay false for a non-exit plan proposal kind")
	}
}

// TestTaskCompleteStatus_CarriesIonConversationID verifies Part B: the
// task_complete → engine_status translation must report Ion's stable
// conversationID, never the backend-reported sessionID (claude's UUID for
// the CLI backend). The pure translateToEngineEvent stamps the backend
// value; handleNormalizedEvent substitutes the Ion id because it has
// session access.
func TestTaskCompleteStatus_CarriesIonConversationID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tc-convid", defaultConfig())
	ec := newEventCollector(mgr)

	const ionConvID = "1781488459985-abcdef012345"
	const claudeUUID = "93abc332-137f-4d91-975f-a41397ec76a2"
	mgr.mu.Lock()
	s := mgr.sessions["tc-convid"]
	s.conversationID = ionConvID
	s.requestID = "run-tc-convid"
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-tc-convid", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:    "done",
			SessionID: claudeUUID, // backend reports claude's UUID
			CostUsd:   0.01,
		},
	})

	var statusSessionID string
	var found bool
	for _, ke := range ec.byType("engine_status") {
		if ke.event.Fields != nil && ke.event.Fields.State == "idle" {
			statusSessionID = ke.event.Fields.SessionID
			found = true
		}
	}
	if !found {
		t.Fatal("no idle engine_status emitted from task_complete")
	}
	if statusSessionID != ionConvID {
		t.Errorf("task_complete status SessionID = %q, want Ion id %q (not claude UUID %q)", statusSessionID, ionConvID, claudeUUID)
	}
}
