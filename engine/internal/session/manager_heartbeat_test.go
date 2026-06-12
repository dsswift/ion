package session

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Heartbeat + QuerySessionStatus tests
// ---------------------------------------------------------------------------
//
// Phase 2 of the state-management overhaul: the per-Manager heartbeat
// goroutine re-emits engine_status for every attached session on a
// configurable cadence, and QuerySessionStatus emits the same payload
// on demand for a single key. Together they guarantee any cache that
// missed an organic engine_status event converges within ≤ one
// heartbeat interval (steady state) or ≤ one network round-trip
// (on-demand).

// captureEngineStatus is a tiny helper that collects engine_status
// events keyed by session-key. Used across these tests to assert
// emissions land on the right key with the right state.
type captureEngineStatus struct {
	mu     sync.Mutex
	events map[string][]types.EngineEvent
}

func newCaptureEngineStatus() *captureEngineStatus {
	return &captureEngineStatus{events: make(map[string][]types.EngineEvent)}
}

func (c *captureEngineStatus) handler() func(string, types.EngineEvent) {
	return func(key string, ev types.EngineEvent) {
		if ev.Type != "engine_status" {
			return
		}
		c.mu.Lock()
		c.events[key] = append(c.events[key], ev)
		c.mu.Unlock()
	}
}

func (c *captureEngineStatus) countFor(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.events[key])
}

func (c *captureEngineStatus) last(key string) (types.EngineEvent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	evs := c.events[key]
	if len(evs) == 0 {
		return types.EngineEvent{}, false
	}
	return evs[len(evs)-1], true
}

// TestHeartbeat_EmitsForEveryAttachedSession verifies the steady-state
// case: the manager's heartbeat goroutine ticks at the configured
// cadence and re-emits engine_status for every attached session. A
// freshly-attached desktop that missed the organic emission still
// converges within one heartbeat interval.
func TestHeartbeat_EmitsForEveryAttachedSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	// Aggressive cadence so the test does not block on the default 30 s.
	mgr.SetHeartbeatInterval(50 * time.Millisecond)

	_, _ = mgr.StartSession("hb-session-a", defaultConfig())
	_, _ = mgr.StartSession("hb-session-b", defaultConfig())

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	// Wait for at least two ticks so we know the goroutine is firing.
	// Each tick should emit one engine_status per session.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cap.countFor("hb-session-a") >= 2 && cap.countFor("hb-session-b") >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if cap.countFor("hb-session-a") < 2 {
		t.Errorf("expected at least 2 heartbeat emissions for hb-session-a, got %d", cap.countFor("hb-session-a"))
	}
	if cap.countFor("hb-session-b") < 2 {
		t.Errorf("expected at least 2 heartbeat emissions for hb-session-b, got %d", cap.countFor("hb-session-b"))
	}
	// Both sessions are idle; heartbeat must reflect that.
	if last, ok := cap.last("hb-session-a"); ok {
		if last.Fields == nil || last.Fields.State != "idle" {
			t.Errorf("expected heartbeat state=idle for hb-session-a, got %+v", last.Fields)
		}
	}
}

// TestHeartbeat_StopsOnShutdown verifies the goroutine terminates when
// Shutdown is called. A leaked goroutine would emit events past the
// test boundary and pollute subsequent tests sharing the same backend
// mock.
func TestHeartbeat_StopsOnShutdown(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetHeartbeatInterval(20 * time.Millisecond)
	_, _ = mgr.StartSession("hb-stop", defaultConfig())

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	// Let at least one tick fire so we know the goroutine is alive.
	time.Sleep(80 * time.Millisecond)
	before := cap.countFor("hb-stop")
	if before == 0 {
		t.Fatal("expected at least one heartbeat emission before Shutdown")
	}

	mgr.Shutdown()
	// Wait several tick intervals; if the goroutine survived Shutdown
	// it would emit more events.
	time.Sleep(150 * time.Millisecond)
	after := cap.countFor("hb-stop")
	// Some slop allowed: a tick that was already in-flight when
	// Shutdown closed the stop channel may still emit. We assert the
	// growth is small and bounded, not exactly zero.
	if after-before > 1 {
		t.Errorf("expected heartbeat to stop after Shutdown, but grew from %d to %d", before, after)
	}
}

// TestHeartbeat_ClearsStaleRequestIDOnTick verifies that the heartbeat
// path exercises the Phase 1 cross-check: a session with a stranded
// requestID that the backend disclaims is cleared on the next tick and
// the heartbeat reports state=idle (not running). This is the
// end-to-end Phase 1 + Phase 2 regression for Ion Operations.
func TestHeartbeat_ClearsStaleRequestIDOnTick(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(40 * time.Millisecond)

	_, _ = mgr.StartSession("hb-stale", defaultConfig())
	mgr.mu.Lock()
	mgr.sessions["hb-stale"].requestID = "run-zombie-orchestrator"
	mgr.mu.Unlock()

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if last, ok := cap.last("hb-stale"); ok && last.Fields != nil && last.Fields.State == "idle" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	last, ok := cap.last("hb-stale")
	if !ok {
		t.Fatal("expected at least one heartbeat emission for hb-stale")
	}
	if last.Fields == nil || last.Fields.State != "idle" {
		t.Errorf("expected heartbeat state=idle after stale-requestID clear, got %+v", last.Fields)
	}

	mgr.mu.RLock()
	cleared := mgr.sessions["hb-stale"].requestID
	mgr.mu.RUnlock()
	if cleared != "" {
		t.Errorf("expected heartbeat tick to clear stranded requestID, got %q", cleared)
	}
}

// TestQuerySessionStatus_EmitsForAttachedKey verifies the on-demand
// counterpart: callers ask the engine for a fresh status for a key
// and the engine emits engine_status on the normal event channel.
func TestQuerySessionStatus_EmitsForAttachedKey(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	// Quiet the heartbeat so it cannot race with the test emission.
	mgr.SetHeartbeatInterval(10 * time.Second)

	_, _ = mgr.StartSession("query-session", defaultConfig())

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	mgr.QuerySessionStatus("query-session")

	if cap.countFor("query-session") != 1 {
		t.Fatalf("expected exactly 1 status emission from QuerySessionStatus, got %d", cap.countFor("query-session"))
	}
	last, _ := cap.last("query-session")
	if last.Fields == nil || last.Fields.State != "idle" {
		t.Errorf("expected query state=idle for fresh session, got %+v", last.Fields)
	}
}

// TestQuerySessionStatus_NoEmissionForUnknownKey verifies the
// out-of-sync caller case: the engine logs a warning and does not
// emit anything when asked about a session it does not know.
func TestQuerySessionStatus_NoEmissionForUnknownKey(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Second)

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	mgr.QuerySessionStatus("definitely-not-a-real-session-key")

	if got := cap.countFor("definitely-not-a-real-session-key"); got != 0 {
		t.Errorf("expected 0 emissions for unknown key, got %d", got)
	}
}

// TestQuerySessionStatus_ClearsStaleRequestID is the on-demand
// regression for the Ion Operations failure: an attached session
// whose requestID is stranded surfaces as idle through the query
// path, mirroring the heartbeat path's behavior.
func TestQuerySessionStatus_ClearsStaleRequestID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(10 * time.Second)

	_, _ = mgr.StartSession("query-stale", defaultConfig())
	mgr.mu.Lock()
	mgr.sessions["query-stale"].requestID = "run-orphan-via-query"
	mgr.mu.Unlock()

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	mgr.QuerySessionStatus("query-stale")

	last, ok := cap.last("query-stale")
	if !ok {
		t.Fatal("expected emission from QuerySessionStatus")
	}
	if last.Fields == nil || last.Fields.State != "idle" {
		t.Errorf("expected query state=idle after stale-requestID clear, got %+v", last.Fields)
	}

	mgr.mu.RLock()
	cleared := mgr.sessions["query-stale"].requestID
	mgr.mu.RUnlock()
	if cleared != "" {
		t.Errorf("expected QuerySessionStatus to clear stranded requestID, got %q", cleared)
	}
}

// TestSetHeartbeatInterval_RestoresDefaultOnZero verifies the
// override knob behaves as a tri-state: zero or negative reverts to
// DefaultSessionStatusHeartbeatInterval, positive values are used
// verbatim.
func TestSetHeartbeatInterval_RestoresDefaultOnZero(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()

	mgr.SetHeartbeatInterval(123 * time.Millisecond)
	if got := mgr.snapshotHeartbeatInterval(); got != 123*time.Millisecond {
		t.Errorf("expected interval=123ms, got %v", got)
	}
	mgr.SetHeartbeatInterval(0)
	if got := mgr.snapshotHeartbeatInterval(); got != DefaultSessionStatusHeartbeatInterval {
		t.Errorf("expected interval to revert to default on zero, got %v", got)
	}
	mgr.SetHeartbeatInterval(-1 * time.Second)
	if got := mgr.snapshotHeartbeatInterval(); got != DefaultSessionStatusHeartbeatInterval {
		t.Errorf("expected interval to revert to default on negative, got %v", got)
	}
}
