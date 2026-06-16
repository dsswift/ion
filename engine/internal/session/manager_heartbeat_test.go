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
// contract: each heartbeat tick re-emits engine_status for every attached
// session, with idle state for an idle session. A freshly-attached desktop
// that missed the organic emission still converges within one heartbeat.
//
// The behavioral contract ("every attached session gets an emission per
// tick") is asserted by driving emitHeartbeatTick() directly — the same
// helper the goroutine calls — rather than waiting on the wall-clock ticker.
// The previous version waited up to 2 s for a 50 ms ticker to fire ≥2 times;
// under a CPU-pressured Linux -race runner the heartbeat goroutine is starved
// (lock contention on m.mu against the whole package's tests) and emitted 0
// times in the window, so the test flaked with "got 0". Driving the tick
// directly is deterministic and strengthens the assertion (it pins the exact
// per-tick fan-out, not "the scheduler eventually ran the goroutine").
// TestHeartbeat_GoroutineFiresOnTimer below separately covers that the
// NewManager-spawned goroutine actually fires on its timer.
func TestHeartbeat_EmitsForEveryAttachedSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	// Quiet the background goroutine so it cannot race with the direct
	// ticks this test drives. We assert on emitHeartbeatTick() directly.
	mgr.SetHeartbeatInterval(10 * time.Second)

	_, _ = mgr.StartSession("hb-session-a", defaultConfig())
	_, _ = mgr.StartSession("hb-session-b", defaultConfig())

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	// Two explicit ticks. Each tick must emit engine_status once per
	// attached session, so after two ticks each session has exactly two.
	mgr.emitHeartbeatTick()
	mgr.emitHeartbeatTick()

	if got := cap.countFor("hb-session-a"); got != 2 {
		t.Errorf("expected exactly 2 heartbeat emissions for hb-session-a, got %d", got)
	}
	if got := cap.countFor("hb-session-b"); got != 2 {
		t.Errorf("expected exactly 2 heartbeat emissions for hb-session-b, got %d", got)
	}
	// Both sessions are idle; heartbeat must reflect that.
	if last, ok := cap.last("hb-session-a"); ok {
		if last.Fields == nil || last.Fields.State != "idle" {
			t.Errorf("expected heartbeat state=idle for hb-session-a, got %+v", last.Fields)
		}
	}
}

// TestHeartbeat_GoroutineFiresOnTimer verifies the wiring that the
// per-Manager goroutine spawned by NewManager actually fires on its timer
// (as opposed to emitHeartbeatTick, which the test above drives directly).
//
// This is intentionally tolerant: it asserts at least ONE emission within a
// generous deadline, not an exact count on a tight cadence. Asserting an
// exact tick count against the wall clock is what made the old test flake on
// a CPU-pressured Linux -race runner — the goroutine can be scheduler-starved
// and still be correctly wired. "At least one emission within 3 s for a 25 ms
// ticker" tolerates heavy starvation while still failing if the goroutine is
// never started or never reaches the handler.
func TestHeartbeat_GoroutineFiresOnTimer(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	mgr.SetHeartbeatInterval(25 * time.Millisecond)

	_, _ = mgr.StartSession("hb-timer", defaultConfig())

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cap.countFor("hb-timer") >= 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if cap.countFor("hb-timer") < 1 {
		t.Errorf("expected the heartbeat goroutine to emit at least once within the deadline, got 0")
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
	// Quiet the background goroutine; drive the tick directly so the
	// assertion does not depend on the wall-clock ticker firing under load.
	mgr.SetHeartbeatInterval(10 * time.Second)

	_, _ = mgr.StartSession("hb-stale", defaultConfig())
	mgr.mu.Lock()
	mgr.sessions["hb-stale"].requestID = "run-zombie-orchestrator"
	mgr.mu.Unlock()

	cap := newCaptureEngineStatus()
	mgr.OnEvent(cap.handler())

	// One tick must clear the stranded requestID and report idle.
	mgr.emitHeartbeatTick()

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

// TestHeartbeat_EmitsAgentStateForEverySession verifies that each heartbeat
// tick emits engine_agent_state alongside engine_status.  This is the
// passive convergence mechanism for agent state — if a reconnecting
// client missed the one-shot reconcile, its agent panel converges
// within one heartbeat interval.
//
// Driven via emitHeartbeatTick() directly (not the wall-clock ticker) so the
// per-tick fan-out is asserted deterministically and the test does not flake
// under CPU-pressured Linux -race load — see the note on
// TestHeartbeat_EmitsForEveryAttachedSession.
func TestHeartbeat_EmitsAgentStateForEverySession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	defer mgr.Shutdown()
	// Quiet the background goroutine so it cannot add stray emissions while
	// we assert exact per-tick counts from the direct ticks below.
	mgr.SetHeartbeatInterval(10 * time.Second)

	_, _ = mgr.StartSession("hb-agent-a", defaultConfig())
	_, _ = mgr.StartSession("hb-agent-b", defaultConfig())

	var mu sync.Mutex
	agentEvents := make(map[string]int)
	mgr.OnEvent(func(key string, ev types.EngineEvent) {
		if ev.Type == "engine_agent_state" {
			mu.Lock()
			agentEvents[key]++
			mu.Unlock()
		}
	})

	// Two explicit ticks → exactly two agent_state emissions per session.
	mgr.emitHeartbeatTick()
	mgr.emitHeartbeatTick()

	mu.Lock()
	defer mu.Unlock()
	if agentEvents["hb-agent-a"] != 2 {
		t.Errorf("expected exactly 2 agent_state heartbeat emissions for hb-agent-a, got %d", agentEvents["hb-agent-a"])
	}
	if agentEvents["hb-agent-b"] != 2 {
		t.Errorf("expected exactly 2 agent_state heartbeat emissions for hb-agent-b, got %d", agentEvents["hb-agent-b"])
	}
}
