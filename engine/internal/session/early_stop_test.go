package session

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestHandleEarlyStopDecisionResponse_ResolvesPendingRequest exercises the
// happy path: the runloop registers a pending request via the broker, the
// server delivers an early_stop_decision_response, the response reaches
// the waiting goroutine.
func TestHandleEarlyStopDecisionResponse_ResolvesPendingRequest(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "es-resolve"
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{key: newCliSession(key)}
	mgr.mu.Unlock()

	s := mgr.sessions[key]
	requestID := "es-req-1"
	ch := s.pending.RegisterEarlyStop(requestID)
	defer s.pending.UnregisterEarlyStop(requestID)

	cont := true
	go func() {
		// Slight delay so the receive below is the one waiting, not the
		// send. Mirrors the broker round-trip test cadence.
		time.Sleep(time.Millisecond)
		mgr.HandleEarlyStopDecisionResponse(key, requestID, &cont, 200, 80, "harness msg")
	}()

	select {
	case reply := <-ch:
		if reply.ForceContinue == nil || !*reply.ForceContinue {
			t.Errorf("ForceContinue: want &true, got %v", reply.ForceContinue)
		}
		if reply.OverrideBudget != 200 {
			t.Errorf("OverrideBudget: want 200, got %d", reply.OverrideBudget)
		}
		if reply.OverrideThresholdPct != 80 {
			t.Errorf("OverrideThresholdPct: want 80, got %d", reply.OverrideThresholdPct)
		}
		if reply.ContinueMessage != "harness msg" {
			t.Errorf("ContinueMessage: want 'harness msg', got %q", reply.ContinueMessage)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for response delivery")
	}
}

// TestHandleEarlyStopDecisionResponse_UnknownSessionIsNoop confirms a
// response for a session that doesn't exist (e.g. session torn down
// between event emission and response arrival) is silently dropped
// rather than panicking. Mirrors the elicitation/permission unknown-
// session behavior.
func TestHandleEarlyStopDecisionResponse_UnknownSessionIsNoop(t *testing.T) {
	mgr := NewManager(newMockBackend())
	// Don't panic; don't deliver anywhere.
	mgr.HandleEarlyStopDecisionResponse("nonexistent", "req-x", nil, 0, 0, "msg")
}

// TestHandleEarlyStopDecisionResponse_StaleRequestIsNoop confirms a
// response after the runloop already moved on (timed out and
// unregistered) is silently dropped — the broker returns false and the
// engine logs at debug level. This is the race we expect under load:
// consumer sends late, engine already proceeded.
func TestHandleEarlyStopDecisionResponse_StaleRequestIsNoop(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "es-stale"
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{key: newCliSession(key)}
	mgr.mu.Unlock()

	// Register then immediately unregister to simulate a timeout.
	s := mgr.sessions[key]
	s.pending.RegisterEarlyStop("stale")
	s.pending.UnregisterEarlyStop("stale")

	// Should not panic, should not deliver to anyone.
	cont := false
	mgr.HandleEarlyStopDecisionResponse(key, "stale", &cont, 0, 0, "")
}

// TestRequestEarlyStopDecisionViaWire_DeliversResponse exercises the
// engine-side flow end-to-end: the manager emits the request event,
// blocks on the channel, and returns the response when one arrives via
// HandleEarlyStopDecisionResponse. The two paths must round-trip
// cleanly so socket-only harnesses can participate in the hook.
func TestRequestEarlyStopDecisionViaWire_DeliversResponse(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "es-wire-rt"
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{key: newCliSession(key)}
	mgr.mu.Unlock()

	// Capture the emitted event so we can extract its request ID and
	// simulate a wire-protocol consumer.
	var emittedRequestID string
	var emitMu sync.Mutex
	mgr.OnEvent(func(emittedKey string, ev types.EngineEvent) {
		if emittedKey != key || ev.Type != "engine_early_stop_decision_request" {
			return
		}
		if !ev.EarlyStopEligible {
			t.Error("wire event omitted mechanical eligibility")
		}
		emitMu.Lock()
		emittedRequestID = ev.EarlyStopRequestID
		emitMu.Unlock()

		// Simulate a consumer responding. Do this on a goroutine so the
		// blocking requestEarlyStopDecisionViaWire call can proceed
		// while we synthesize the response.
		go func(reqID string) {
			time.Sleep(2 * time.Millisecond)
			cont := true
			mgr.HandleEarlyStopDecisionResponse(key, reqID, &cont, 0, 0, "from wire")
		}(ev.EarlyStopRequestID)
	})

	info := backend.EarlyStopDecisionInfo{
		RunID:                  "run-1",
		Model:                  "test-model",
		TurnNumber:             1,
		StopReason:             "end_turn",
		CumulativeOutputTokens: 50,
		Budget:                 100,
		ThresholdPct:           90,
		WouldContinue:          true,
		Eligible:               true,
	}
	result := mgr.requestEarlyStopDecisionViaWire(key, info)

	if result == nil {
		t.Fatal("expected non-nil result, got nil")
	}
	if result.ForceContinue == nil || !*result.ForceContinue {
		t.Errorf("ForceContinue: want &true, got %v", result.ForceContinue)
	}
	if result.ContinueMessage != "from wire" {
		t.Errorf("ContinueMessage: want 'from wire', got %q", result.ContinueMessage)
	}

	// Sanity-check the emitted request ID matches the prefix the engine
	// uses so consumers can grep for it in logs.
	emitMu.Lock()
	gotID := emittedRequestID
	emitMu.Unlock()
	if gotID == "" {
		t.Error("emitted event had no EarlyStopRequestID")
	}
	if len(gotID) < len("early-stop-") || gotID[:len("early-stop-")] != "early-stop-" {
		t.Errorf("emitted request ID does not carry expected prefix: %q", gotID)
	}
}

// TestRequestEarlyStopDecisionViaWire_TimesOut confirms the engine
// returns nil when no consumer responds within the timeout. This is the
// fall-through case for socket-less or unresponsive harnesses; the
// engine must not stall the agent loop.
func TestRequestEarlyStopDecisionViaWire_TimesOut(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "es-wire-timeout"
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{key: newCliSession(key)}
	mgr.mu.Unlock()

	// No event callback wired → nobody responds.
	info := backend.EarlyStopDecisionInfo{
		RunID:         "run-timeout",
		TurnNumber:    1,
		StopReason:    "end_turn",
		WouldContinue: true,
	}

	start := time.Now()
	result := mgr.requestEarlyStopDecisionViaWire(key, info)
	elapsed := time.Since(start)

	if result != nil {
		t.Errorf("expected nil on timeout, got %+v", result)
	}
	// Timeout should be at least the configured threshold but not orders
	// of magnitude longer (allow generous headroom for CI noise).
	if elapsed < earlyStopWireTimeout {
		t.Errorf("timeout fired too early: %s < %s", elapsed, earlyStopWireTimeout)
	}
	if elapsed > earlyStopWireTimeout+50*time.Millisecond {
		t.Errorf("timeout fired too late: %s > %s + headroom", elapsed, earlyStopWireTimeout)
	}
}

// TestRequestEarlyStopDecisionViaWire_UnknownSessionReturnsNil confirms
// that calling the wire-fan-out path for a non-existent session returns
// nil immediately (without emitting an event or blocking). Defends
// against a race where the session is torn down between the runloop's
// callback and the manager's lookup.
func TestRequestEarlyStopDecisionViaWire_UnknownSessionReturnsNil(t *testing.T) {
	mgr := NewManager(newMockBackend())

	start := time.Now()
	result := mgr.requestEarlyStopDecisionViaWire("nonexistent", backend.EarlyStopDecisionInfo{})
	elapsed := time.Since(start)

	if result != nil {
		t.Errorf("expected nil for unknown session, got %+v", result)
	}
	// Should return immediately, not wait the full timeout.
	if elapsed > 10*time.Millisecond {
		t.Errorf("unknown-session path took too long: %s (expected near-instant)", elapsed)
	}
}
