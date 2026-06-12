package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// engine_session_status mirror tests — Phase 3 of state-management overhaul
// ---------------------------------------------------------------------------
//
// Every engine_status emission must be mirrored as an engine_session_status
// emission so consumers that have migrated to the new typed surface receive
// the same authoritative state without parsing engine_status. The mirror
// fires at the Manager.emit chokepoint so the contract holds for every
// emission site uniformly (heartbeat, ReconcileState, QuerySessionStatus,
// per-prompt dispatch, task-complete, run-exit, host-death,
// start-session, etc.).

// TestEmit_MirrorsEngineStatusToSessionStatus verifies the dual-emit
// contract: a single engine_status emission produces two events on the
// subscriber callback — the original engine_status followed
// immediately by an engine_session_status carrying the same
// authoritative state.
func TestEmit_MirrorsEngineStatusToSessionStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	// Quiet the heartbeat so it cannot race with the assertion.
	mgr.SetHeartbeatInterval(10 * 1000_000_000) // 10 seconds (in ns)

	_, _ = mgr.StartSession("mirror-key", defaultConfig())

	var mu sync.Mutex
	var events []types.EngineEvent
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		mu.Lock()
		defer mu.Unlock()
		// Filter to status events from our key so we don't pick up
		// the engine_working_message side traffic.
		if key == "mirror-key" && (ev.Type == "engine_status" || ev.Type == "engine_session_status") {
			events = append(events, ev)
		}
	})

	// Drive a synthetic engine_status emission directly through the
	// chokepoint. Using ReconcileState is the most direct test path —
	// it always emits one engine_status from a known site.
	mgr.ReconcileState("mirror-key")

	mu.Lock()
	defer mu.Unlock()
	if len(events) != 2 {
		t.Fatalf("expected exactly 2 events (engine_status + engine_session_status), got %d: %+v", len(events), events)
	}
	if events[0].Type != "engine_status" {
		t.Errorf("expected first event type=engine_status, got %q", events[0].Type)
	}
	if events[1].Type != "engine_session_status" {
		t.Errorf("expected second event type=engine_session_status, got %q", events[1].Type)
	}
	if events[1].SessionStatus == nil {
		t.Fatal("expected engine_session_status to carry SessionStatus payload")
	}
	if events[1].SessionStatus.Key != "mirror-key" {
		t.Errorf("expected SessionStatus.Key=mirror-key, got %q", events[1].SessionStatus.Key)
	}
	if events[1].SessionStatus.LastEmittedAt == 0 {
		t.Error("expected SessionStatus.LastEmittedAt to be populated with current unix-ms")
	}
	// State on the mirror must match the State on the legacy event.
	if events[0].Fields == nil || events[0].Fields.State != events[1].SessionStatus.State {
		t.Errorf("mirror state must match legacy state: legacy=%v mirror=%v", events[0].Fields, events[1].SessionStatus)
	}
}

// TestBuildSessionStatusMirror_NilSessionHandled verifies the pure
// helper's defensive nil path. After StopSession the session map drops
// the engineSession pointer; a status event that lands after that
// must still produce a valid mirror (it just carries fewer fields).
func TestBuildSessionStatusMirror_NilSessionHandled(t *testing.T) {
	f := &types.StatusFields{State: "idle", Model: "claude-3-5-sonnet", ContextPercent: 42}
	mirror := buildSessionStatusMirror("orphan-key", f, nil)
	if mirror == nil {
		t.Fatal("expected non-nil mirror even with nil session pointer")
	}
	if mirror.Type != "engine_session_status" {
		t.Errorf("expected mirror type=engine_session_status, got %q", mirror.Type)
	}
	if mirror.SessionStatus == nil {
		t.Fatal("expected mirror.SessionStatus to be set")
	}
	if mirror.SessionStatus.HasInflightRun {
		t.Error("expected HasInflightRun=false when session pointer is nil (no requestID to inspect)")
	}
	if mirror.SessionStatus.State != "idle" {
		t.Errorf("expected State to be preserved from StatusFields, got %q", mirror.SessionStatus.State)
	}
	if mirror.SessionStatus.Model != "claude-3-5-sonnet" {
		t.Errorf("expected Model to be preserved from StatusFields, got %q", mirror.SessionStatus.Model)
	}
	if mirror.SessionStatus.LastEmittedAt == 0 {
		t.Error("expected LastEmittedAt to be populated even for nil-session mirror")
	}
}

// TestBuildSessionStatusMirror_HasInflightRunReflectsSession verifies
// the cross-check signal the mirror provides: when the engine has a
// live requestID for this session, the mirror reports
// HasInflightRun=true. This is the field consumers will use to
// distinguish "engine has no live run" from "we haven't received an
// event yet" once the dispatcher migration completes (Phase 4).
func TestBuildSessionStatusMirror_HasInflightRunReflectsSession(t *testing.T) {
	s := &engineSession{
		key:            "inflight-key",
		conversationID: "conv-123",
		requestID:      "run-xyz",
	}
	f := &types.StatusFields{State: "running"}
	mirror := buildSessionStatusMirror("inflight-key", f, s)
	if !mirror.SessionStatus.HasInflightRun {
		t.Error("expected HasInflightRun=true when session.requestID is non-empty")
	}
	if mirror.SessionStatus.SessionID != "conv-123" {
		t.Errorf("expected SessionID=conv-123 from session, got %q", mirror.SessionStatus.SessionID)
	}
}

// TestBuildSessionStatusMirror_StatusFieldsSessionIDOverrides verifies
// the SessionID precedence rule: when StatusFields.SessionID is set
// (the engine stamps it on TaskComplete-driven status events) the
// mirror uses that value rather than the session's stored
// conversationID. The legacy event already has this behavior; the
// mirror must track it so consumers cannot disagree based on which
// event they read.
func TestBuildSessionStatusMirror_StatusFieldsSessionIDOverrides(t *testing.T) {
	s := &engineSession{conversationID: "stale-conv"}
	f := &types.StatusFields{State: "idle", SessionID: "fresh-conv"}
	mirror := buildSessionStatusMirror("override-key", f, s)
	if mirror.SessionStatus.SessionID != "fresh-conv" {
		t.Errorf("expected StatusFields.SessionID to win, got %q", mirror.SessionStatus.SessionID)
	}
}
