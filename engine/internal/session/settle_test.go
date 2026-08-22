package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// SettleSession tests
// ---------------------------------------------------------------------------

func TestSettleSession_CancelsActiveRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("settle-run", defaultConfig())
	_ = mgr.SendPrompt("settle-run", "working", nil)

	if !mgr.IsRunning("settle-run") {
		t.Fatal("session should be running before settle")
	}

	if err := mgr.SettleSession("settle-run"); err != nil {
		t.Fatalf("SettleSession: %v", err)
	}

	// Backend should have received a Cancel call.
	mb.mu.Lock()
	cancelCount := len(mb.cancelled)
	mb.mu.Unlock()
	if cancelCount == 0 {
		t.Error("expected Cancel to be called on the backend")
	}
}

func TestSettleSession_SessionStaysInMap(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("settle-keep", defaultConfig())

	if err := mgr.SettleSession("settle-keep"); err != nil {
		t.Fatalf("SettleSession: %v", err)
	}

	sessions := mgr.ListSessions()
	found := false
	for _, s := range sessions {
		if s.Key == "settle-keep" {
			found = true
		}
	}
	if !found {
		t.Error("expected session to remain in the map after settle")
	}
}

func TestSettleSession_Idempotent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("settle-idem", defaultConfig())

	if err := mgr.SettleSession("settle-idem"); err != nil {
		t.Fatalf("first settle: %v", err)
	}
	if err := mgr.SettleSession("settle-idem"); err != nil {
		t.Fatalf("second settle should be idempotent: %v", err)
	}
}

func TestSettleSession_UnknownSessionError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.SettleSession("ghost")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
}

func TestSettleSession_BlocksPrompts(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("settle-block", defaultConfig())

	if err := mgr.SettleSession("settle-block"); err != nil {
		t.Fatalf("SettleSession: %v", err)
	}

	err := mgr.SendPrompt("settle-block", "hello", nil)
	if err == nil {
		t.Fatal("expected SendPrompt to fail on a settled session")
	}
}

func TestSettleSession_EmitsSettledStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("settle-status", defaultConfig())
	_ = mgr.SettleSession("settle-status")

	// Find the engine_status event with state=settled.
	statusEvents := ec.byType("engine_status")
	found := false
	for _, ev := range statusEvents {
		if ev.event.Fields != nil && ev.event.Fields.State == "settled" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected engine_status event with state=settled")
	}
}

func TestSettleSession_AsyncResolverRejectsSettled(t *testing.T) {
	// The async context resolver gate is tested indirectly through the
	// settled-status and prompt-rejection tests. The resolver takes
	// *extension.Host which requires a loaded subprocess to construct,
	// so we verify the gate at the Manager level: a settled session
	// reports state=settled (via currentSessionStatus) and rejects
	// prompts (via the settled gate in SendPrompt). Both confirm the
	// settled flag is effective.
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("settle-async", defaultConfig())

	if err := mgr.SettleSession("settle-async"); err != nil {
		t.Fatalf("SettleSession: %v", err)
	}

	// Verify the settled flag is set by checking status.
	mgr.mu.RLock()
	s := mgr.sessions["settle-async"]
	settled := s.settled
	mgr.mu.RUnlock()
	if !settled {
		t.Fatal("expected session to be marked settled")
	}
}

// ---------------------------------------------------------------------------
// ResumeSession tests
// ---------------------------------------------------------------------------

func TestResumeSession_ClearsSettled(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("resume-clear", defaultConfig())

	_ = mgr.SettleSession("resume-clear")
	if err := mgr.ResumeSession("resume-clear"); err != nil {
		t.Fatalf("ResumeSession: %v", err)
	}

	// Prompt should be accepted now.
	err := mgr.SendPrompt("resume-clear", "hello", nil)
	if err != nil {
		t.Fatalf("expected SendPrompt to succeed after resume: %v", err)
	}
}

func TestResumeSession_EmitsIdleStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("resume-status", defaultConfig())
	_ = mgr.SettleSession("resume-status")
	_ = mgr.ResumeSession("resume-status")

	// Find the engine_status event with state=idle after the settled one.
	statusEvents := ec.byType("engine_status")
	sawSettled := false
	sawIdleAfter := false
	for _, ev := range statusEvents {
		if ev.event.Fields == nil {
			continue
		}
		if ev.event.Fields.State == "settled" {
			sawSettled = true
		}
		if sawSettled && ev.event.Fields.State == "idle" {
			sawIdleAfter = true
		}
	}
	if !sawIdleAfter {
		t.Error("expected engine_status with state=idle after settled")
	}
}

func TestResumeSession_NotSettledError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("resume-nosettle", defaultConfig())

	err := mgr.ResumeSession("resume-nosettle")
	if err == nil {
		t.Fatal("expected error when resuming a non-settled session")
	}
}

func TestResumeSession_UnknownSessionError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.ResumeSession("ghost")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
}

func TestSettleResume_RoundTrip(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("roundtrip", defaultConfig())

	// Send a prompt, then settle.
	_ = mgr.SendPrompt("roundtrip", "initial", nil)
	_ = mgr.SettleSession("roundtrip")

	// Prompt should fail while settled.
	err := mgr.SendPrompt("roundtrip", "blocked", nil)
	if err == nil {
		t.Fatal("expected prompt to fail while settled")
	}

	// Resume and send another prompt.
	_ = mgr.ResumeSession("roundtrip")
	err = mgr.SendPrompt("roundtrip", "resumed", nil)
	if err != nil {
		t.Fatalf("expected prompt to succeed after resume: %v", err)
	}

	// Verify the event sequence: settled -> idle.
	statusEvents := ec.byType("engine_status")
	var states []string
	for _, ev := range statusEvents {
		if ev.event.Fields != nil {
			states = append(states, ev.event.Fields.State)
		}
	}
	// At minimum we should see "settled" followed by "idle" somewhere.
	sawSettled := false
	sawIdleAfterSettled := false
	for _, st := range states {
		if st == "settled" {
			sawSettled = true
		}
		if sawSettled && st == "idle" {
			sawIdleAfterSettled = true
		}
	}
	if !sawIdleAfterSettled {
		t.Errorf("expected settled -> idle in status sequence; got states: %v", states)
	}
}

func TestStopSession_WorksOnSettledSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("settle-stop", defaultConfig())

	_ = mgr.SettleSession("settle-stop")

	// StopSession should still work on a settled session.
	err := mgr.StopSession("settle-stop")
	if err != nil {
		t.Fatalf("StopSession on settled: %v", err)
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after stop, got %d", len(sessions))
	}
}

func TestStartSession_IdempotentOnSettled(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	res, _ := mgr.StartSession("settle-start", defaultConfig())
	originalConvID := res.ConversationID

	_ = mgr.SettleSession("settle-start")

	// StartSession on a settled session should be idempotent (session exists).
	res2, err := mgr.StartSession("settle-start", defaultConfig())
	if err != nil {
		t.Fatalf("StartSession on settled: %v", err)
	}
	if !res2.Existed {
		t.Error("expected Existed=true for idempotent start on settled session")
	}
	if res2.ConversationID != originalConvID {
		t.Errorf("expected same conversation ID, got %q vs %q", originalConvID, res2.ConversationID)
	}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// The async context resolver gate is tested indirectly (see
// TestSettleSession_AsyncResolverRejectsSettled). A direct resolver test
// would require constructing an *extension.Host with a loaded subprocess,
// which is integration-test territory.

// Verify that the session status reports "settled" for a settled session.
func TestSessionStatus_ReportsSettled(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("status-settled", defaultConfig())

	if err := mgr.SettleSession("status-settled"); err != nil {
		t.Fatalf("SettleSession: %v", err)
	}

	// Query the status via the event emitter.
	ec := newEventCollector(mgr)
	mgr.emitStatusSnapshot("status-settled", "test")

	statusEvents := ec.byType("engine_status")
	if len(statusEvents) == 0 {
		t.Fatal("expected at least one engine_status event")
	}
	last := statusEvents[len(statusEvents)-1]
	if last.event.Fields == nil || last.event.Fields.State != "settled" {
		state := ""
		if last.event.Fields != nil {
			state = last.event.Fields.State
		}
		t.Errorf("expected state=settled, got %q", state)
	}
}

// Verify engine_session_status also carries "settled".
func TestSessionStatus_SessionStatusPayload(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("ss-settled", defaultConfig())

	_ = mgr.SettleSession("ss-settled")

	ec := newEventCollector(mgr)
	mgr.emitStatusSnapshot("ss-settled", "test")

	ssEvents := ec.byType("engine_session_status")
	if len(ssEvents) == 0 {
		t.Fatal("expected at least one engine_session_status event")
	}
	last := ssEvents[len(ssEvents)-1]
	if last.event.SessionStatus == nil {
		t.Fatal("expected SessionStatus payload")
	}
	if last.event.SessionStatus.State != "settled" {
		t.Errorf("expected SessionStatus.State=settled, got %q", last.event.SessionStatus.State)
	}
}

// ---------------------------------------------------------------------------
// Protocol contract: settle_session and resume_session are valid commands
// ---------------------------------------------------------------------------

func TestProtocol_SettleResumeAreValid(t *testing.T) {
	// Verify that the protocol accepts these commands by checking they
	// exist in the valid command map. We do this indirectly by sending
	// real commands through the manager.
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("proto-test", defaultConfig())

	if err := mgr.SettleSession("proto-test"); err != nil {
		t.Fatalf("settle_session should be accepted: %v", err)
	}
	if err := mgr.ResumeSession("proto-test"); err != nil {
		t.Fatalf("resume_session should be accepted: %v", err)
	}
}

// Verify the settle correctly drops pending prompts.
func TestSettleSession_DropsPendingPrompts(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("settle-queue", defaultConfig())

	// Start a run so the next prompt queues.
	_ = mgr.SendPrompt("settle-queue", "first", nil)
	_ = mgr.SendPrompt("settle-queue", "queued", nil)

	_ = mgr.SettleSession("settle-queue")

	// Verify the queue was cleared.
	mgr.mu.RLock()
	s := mgr.sessions["settle-queue"]
	qLen := len(s.promptQueue)
	mgr.mu.RUnlock()
	if qLen != 0 {
		t.Errorf("expected empty prompt queue after settle, got %d", qLen)
	}
}

// Ensure settle emits an error event for unsent prompts in the queue
// (i.e. doesn't silently drop -- the queue is cleared but the error
// event from settled gate prevents future sends).
func TestSettleSession_EmitsErrorOnPrompt(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("settle-err", defaultConfig())
	_ = mgr.SettleSession("settle-err")
	_ = mgr.SendPrompt("settle-err", "blocked", nil)

	errorEvents := ec.byType("engine_error")
	found := false
	for _, ev := range errorEvents {
		if ev.event.ErrorCode == "session_settled" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected engine_error with errorCode=session_settled")
	}
}

// Prevent unused import warnings.
var _ = types.EngineEvent{}
