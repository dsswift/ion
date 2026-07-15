package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// steerableMockBackend — a RunBackend that also implements the session-local
// `steerable` interface (SteerWithReason). It lets these tests drive every
// branch of Manager.SteerAgent's main-loop path and assert the typed
// SteerOutcome the method now returns. The historical bug was that SteerAgent
// was void: a steer that ApiBackend.Steer could not deliver (channel full, or
// no active run) was swallowed with no return value and no signal to the
// caller. These tests lock in the non-silent outcome.
// ---------------------------------------------------------------------------

type steerableMockBackend struct {
	mu sync.Mutex

	// result is what SteerWithReason returns for any requestID. Tests set it
	// to simulate a live run with channel space (Delivered), a full channel
	// (ChannelFull), or a disclaimed run (NoRun).
	result backend.SteerResult

	// steerCalls records every (requestID, message) handed to SteerWithReason
	// so a test can assert the steer reached the backend (i.e. was buffered
	// for the next drain) rather than being dropped before it got here.
	steerCalls []steerCall

	// running records request IDs that StartRun was called for so IsRunning
	// answers truthfully for the parked-parent scenario.
	running map[string]bool

	onNorm  func(string, types.NormalizedEvent)
	onExitF func(string, *int, *string, string)
	onErrF  func(string, error)
}

type steerCall struct {
	requestID string
	message   string
}

func newSteerableMockBackend(result backend.SteerResult) *steerableMockBackend {
	return &steerableMockBackend{
		result:  result,
		running: make(map[string]bool),
	}
}

func (m *steerableMockBackend) StartRun(requestID string, _ types.RunOptions) {
	m.mu.Lock()
	m.running[requestID] = true
	m.mu.Unlock()
}

func (m *steerableMockBackend) Cancel(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.running[requestID]
	delete(m.running, requestID)
	return ok
}

func (m *steerableMockBackend) IsRunning(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running[requestID]
}

func (m *steerableMockBackend) WriteToStdin(_ string, _ interface{}) error { return nil }
func (m *steerableMockBackend) FlushConversations()                        {}

// Capabilities mirrors mockBackend's engine-owned descriptor (see
// manager_helpers_test.go) so no dispatch gate or history seed engages.
func (m *steerableMockBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{
		Kind:         "mock",
		ContextModel: backend.ContextModelEngineOwned,
		PlanMode:     true,
		Steering:     true,
	}
}

func (m *steerableMockBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	m.onNorm = fn
}
func (m *steerableMockBackend) OnExit(fn func(string, *int, *string, string)) { m.onExitF = fn }
func (m *steerableMockBackend) OnError(fn func(string, error))                { m.onErrF = fn }

// SteerWithReason satisfies the session-local `steerable` interface. It records
// the call and returns the configured result.
func (m *steerableMockBackend) SteerWithReason(requestID, message string) backend.SteerResult {
	m.mu.Lock()
	m.steerCalls = append(m.steerCalls, steerCall{requestID: requestID, message: message})
	res := m.result
	m.mu.Unlock()
	return res
}

func (m *steerableMockBackend) steerCallCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.steerCalls)
}

func (m *steerableMockBackend) lastSteerCall() (steerCall, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.steerCalls) == 0 {
		return steerCall{}, false
	}
	return m.steerCalls[len(m.steerCalls)-1], true
}

// withActiveRun marks a session's main loop as in-flight by stamping a
// requestID, mirroring what prompt dispatch does when a run starts. This is the
// "parent run is live" precondition every steer-delivery test needs.
func withActiveRun(t *testing.T, mgr *Manager, key, requestID string) {
	t.Helper()
	mgr.mu.Lock()
	s, ok := mgr.sessions[key]
	if !ok {
		mgr.mu.Unlock()
		t.Fatalf("withActiveRun: no session %q", key)
	}
	s.requestID = requestID
	mgr.mu.Unlock()
}

// TestSteerAgent_ParkedOnChildren_DeliveredToChannel is the core regression
// test for the silent-drop defect. It models a parent main loop that is live
// (requestID set) and parked awaiting dispatched sub-agents: a steer arriving
// in that window must be DELIVERED to the backend's steer channel (where the
// run loop drains it at the post-tool-results checkpoint after the children
// return) AND SteerAgent must report the non-silent SteerDelivered outcome.
//
// Pre-fix this method was void and returned nothing; this assertion on the
// outcome is impossible to satisfy on the old signature, so the test fails to
// compile / fails on pre-fix code.
func TestSteerAgent_ParkedOnChildren_DeliveredToChannel(t *testing.T) {
	mb := newSteerableMockBackend(backend.SteerResultDelivered)
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("parked", defaultConfig())
	withActiveRun(t, mgr, "parked", "run-parked-1")

	outcome := mgr.SteerAgent("parked", "", "stop and reconsider")

	if outcome != SteerDelivered {
		t.Fatalf("expected SteerDelivered, got %s", outcome)
	}
	if !outcome.Delivered() {
		t.Error("expected outcome.Delivered()==true for a channel delivery")
	}
	// The steer must have actually reached the backend's steer channel — i.e.
	// it was buffered for the next drain, not dropped before delivery.
	if mb.steerCallCount() != 1 {
		t.Fatalf("expected exactly 1 SteerWithReason call, got %d", mb.steerCallCount())
	}
	call, _ := mb.lastSteerCall()
	if call.requestID != "run-parked-1" || call.message != "stop and reconsider" {
		t.Errorf("steer reached backend with wrong payload: %+v", call)
	}
}

// TestSteerAgent_LiveRunChannelHasSpace asserts the enum value for the
// happy path: a live run whose channel has space returns SteerDelivered.
func TestSteerAgent_LiveRunChannelHasSpace(t *testing.T) {
	mb := newSteerableMockBackend(backend.SteerResultDelivered)
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("live", defaultConfig())
	withActiveRun(t, mgr, "live", "run-live-1")

	if got := mgr.SteerAgent("live", "", "go left"); got != SteerDelivered {
		t.Fatalf("expected SteerDelivered, got %s", got)
	}
}

// TestSteerAgent_ChannelFull asserts the enum value for a genuine rejection:
// a live API-backed run whose steer channel is full must surface
// SteerRejectedChannelFull and must NOT silently fall through to the stdin
// no-op (which is how the steer used to vanish).
func TestSteerAgent_ChannelFull(t *testing.T) {
	mb := newSteerableMockBackend(backend.SteerResultChannelFull)
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("full", defaultConfig())
	withActiveRun(t, mgr, "full", "run-full-1")

	got := mgr.SteerAgent("full", "", "too late")
	if got != SteerRejectedChannelFull {
		t.Fatalf("expected SteerRejectedChannelFull, got %s", got)
	}
	if got.Delivered() {
		t.Error("expected outcome.Delivered()==false for a channel-full rejection")
	}
}

// TestSteerAgent_NoActiveRun asserts the enum value when there is no active
// run for the main loop (requestID empty). The steer cannot be delivered and
// must surface SteerRejectedNoRun — loudly, not as a void no-op.
func TestSteerAgent_NoActiveRun(t *testing.T) {
	mb := newSteerableMockBackend(backend.SteerResultDelivered)
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("idle", defaultConfig())
	// No withActiveRun: requestID stays "" — no main-loop run to steer.

	got := mgr.SteerAgent("idle", "", "anyone there?")
	if got != SteerRejectedNoRun {
		t.Fatalf("expected SteerRejectedNoRun, got %s", got)
	}
	if got.Delivered() {
		t.Error("expected outcome.Delivered()==false when there is no active run")
	}
	// The backend must never have been asked to steer — there was no run.
	if mb.steerCallCount() != 0 {
		t.Errorf("expected 0 SteerWithReason calls when no active run, got %d", mb.steerCallCount())
	}
}

// TestSteerAgent_BackendNotApiRouted_FallsBackToStdin asserts that when the
// backend reports SteerResultNoRun (e.g. a CLI/hybrid-CLI run that is not
// API-steerable) SteerAgent falls back to the stdin pipe and reports
// SteerDeliveredViaStdin rather than dropping the steer.
func TestSteerAgent_BackendNotApiRouted_FallsBackToStdin(t *testing.T) {
	mb := newSteerableMockBackend(backend.SteerResultNoRun)
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("cli", defaultConfig())
	withActiveRun(t, mgr, "cli", "run-cli-1")

	got := mgr.SteerAgent("cli", "", "follow up over stdin")
	if got != SteerDeliveredViaStdin {
		t.Fatalf("expected SteerDeliveredViaStdin, got %s", got)
	}
	if !got.Delivered() {
		t.Error("expected outcome.Delivered()==true for a stdin delivery")
	}
}

// TestSteerAgent_UnknownSession_TypedRejection asserts that steering an
// unknown session returns the typed SteerRejectedNoRun rather than a silent
// void return.
func TestSteerAgent_UnknownSession_TypedRejection(t *testing.T) {
	mb := newSteerableMockBackend(backend.SteerResultDelivered)
	mgr := NewManager(mb)

	got := mgr.SteerAgent("ghost", "", "hello?")
	if got != SteerRejectedNoRun {
		t.Fatalf("expected SteerRejectedNoRun for unknown session, got %s", got)
	}
}
