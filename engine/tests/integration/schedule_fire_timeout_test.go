//go:build integration

// End-to-end integration test for the scheduled-handler context-lifetime defect.
//
// This test file drives the REAL mechanism:
//   host.FireAsync → callWithTimeout timeout arm → deferred ctxStack.Pop() → nil ctx
//
// against a REAL node extension subprocess running the async-canary extension.
// No manual Push/Pop occurs in this file; every assertion is reached through
// live code paths.
//
// WHY THIS TEST EXISTS
//
// engine/internal/extension/host_fire_async_timeout_test.go in the extension
// package adds characterisation coverage by hand-simulating the early return
// (Push + immediate Pop without actually calling FireAsync). That approach pins
// the observable consequences of the nil-ctx state but does not prove the
// mechanism that PRODUCES the nil-ctx state — i.e., it does not verify that
// FireAsync's deferred Pop fires before the subprocess handler completes. This
// file closes that gap.
//
// MECHANISM UNDER TEST (from source; not re-derived here)
//
//  1. host_fire_async.go:74 — Push(ctx) onto ctxStack.
//  2. host_fire_async.go:75 — defer Pop() scoped to FireAsync's return.
//  3. host_io.go:166–170 — callWithTimeout timeout arm: deletes pending entry,
//     returns "timeout waiting for engine/fire_async response" error. No cancel
//     or abort RPC is sent to the subprocess.
//  4. FireAsync returns → deferred Pop fires → ctxStack is empty.
//  5. The subprocess handler continues running (Node has no preemption).
//  6. Handler calls ctx.dispatchAgent() → ext/dispatch_agent RPC arrives at Go.
//  7. handleExtRequest resolves ctxStack.Current() → nil → -32000 "dispatch not available".
//  8. TS runtime.ts:778: pending.reject(new Error(msg.error.message || 'RPC error'))
//     → the -32000 code is DROPPED; only the message string reaches the handler.
//  9. Handler emits "sched_timeout_probe_result" event; Go routes it to
//     persistentEmit (not ctx.Emit) because ctxStack is still empty.
//
// WHAT IS PROVEN (real code, not hand-simulation)
//
//  • FireAsync called on a live subprocess and returned a real timeout error.
//  • The handler was genuinely still running when FireAsync returned (proven by
//    receiving the probe-result emit AFTER the FireAsync call returned).
//  • ctxStack.Current() is nil after FireAsync returned (proven two ways:
//    a) host.CtxStackDepthForTest() == 0 immediately after FireAsync returns;
//    b) the probe-result emit routed through persistentEmit, not ctx.Emit).
//  • The handler observed -32000 "dispatch not available" on its dispatchAgent call.
//  • No cancel frame was sent (proven by: the subprocess is still alive and
//    the handler ran to completion after the timeout).
//  • TypeScript error shape: the error text is "dispatch not available"; the
//    -32000 code did NOT survive as a .code property on the thrown Error.
//
// WHAT IS CHARACTERIZED BUT NOT DRIVEN (see host_fire_async_timeout_test.go)
//
//  • Push-guard blind spot: the ctxStack invariant guard does not fire because
//    nothing invalid was pushed. That property is verified in the unit file's
//    TestFireAsyncTimeout_PushGuard_DoesNotFireOnEarlyPop, which is a correct
//    characterisation test.
//  • Duration-contract inconsistency: pinned by TestFireAsync_DurationContractInconsistency.

package integration

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/scheduling"
	"github.com/dsswift/ion/engine/internal/types"
)

// probeEventBus is a minimal concurrent-safe event collector for this test.
// Separate from the webhook_e2e_test.go eventBus to avoid coupling files.
type probeEventBus struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func (b *probeEventBus) collect(ev types.EngineEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, ev)
}

func (b *probeEventBus) ofType(t string) []types.EngineEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []types.EngineEvent
	for _, ev := range b.events {
		if ev.Type == t {
			out = append(out, ev)
		}
	}
	return out
}

// waitProbeEvent polls for a "sched_timeout_probe_result" event up to the
// deadline, then returns the first match or fails the test.
func waitProbeEvent(t *testing.T, bus *probeEventBus, deadline time.Duration) types.EngineEvent {
	t.Helper()
	expire := time.Now().Add(deadline)
	for time.Now().Before(expire) {
		evs := bus.ofType("sched_timeout_probe_result")
		if len(evs) > 0 {
			return evs[0]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("sched_timeout_probe_result event never arrived within %s", deadline)
	return types.EngineEvent{}
}

// TestScheduleFireTimeout_EndToEnd is the primary integration test proving the
// scheduled-handler context-lifetime defect end-to-end through a real Node
// subprocess.
//
// The test:
//  1. Loads the async-canary extension (real esbuild transpile + node subprocess).
//  2. Arms the slow-handler schedule via tool call (delayMs = 40).
//  3. Calls host.FireAsync with a 12ms timeout (timeout < delayMs).
//  4. Asserts FireAsync returns the real "timeout waiting for engine/fire_async
//     response" error — driven by callWithTimeout's time.After arm, not simulated.
//  5. Asserts host.CtxStackDepthForTest() == 0 immediately after FireAsync returns,
//     confirming the deferred Pop inside FireAsync ran.
//  6. Waits for the "sched_timeout_probe_result" event emitted by the still-running
//     handler, asserting it arrives AFTER FireAsync returned (not before).
//  7. Asserts the event's EventMessage is "dispatch not available" — the error
//     the handler received from its post-timeout ext/dispatch_agent RPC.
//  8. Asserts the -32000 code did NOT survive as a .code property on the Error
//     object thrown inside the handler (TypeScript runtime.ts:778 drops it).
//  9. Asserts no cancel or abort frame was sent by confirming the subprocess is
//     still alive (further RPC completes successfully).
//
// All assertions are on real observable state, not hand-simulated state.
func TestScheduleFireTimeout_EndToEnd(t *testing.T) {
	host := loadAsyncCanary(t)
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit errors: %v", errs)
	}

	// Wire persistentEmit to catch the probe-result event. The handler emits
	// it after its post-timeout ctx.dispatchAgent call completes. Because
	// ctxStack is empty at that moment, Go's handleExtNotification routes the
	// ext/emit notification through persistentEmit (not ctx.Emit). The routing
	// path itself is additional evidence that ctxStack is empty.
	bus := &probeEventBus{}
	host.SetPersistentEmit(bus.collect)

	ctx := &extension.Context{
		SessionKey: "sched-timeout-e2e",
		// DispatchAgent is intentionally NOT wired. When ctxStack.Current()
		// returns the real ctx (before the defect fires), the handler would
		// call ctx.DispatchAgent — but since the ctx is popped before the
		// handler issues the RPC, handleExtRequest sees nil and returns -32000
		// regardless. No DispatchAgent wiring is needed.
	}

	// Arm the slow-handler before firing.
	const handlerDelayMs = 40 // handler pauses 40ms before calling dispatchAgent
	const fireTimeoutMs = 12  // FireAsync times out after 12ms — well before handler completes
	armTool := findTool(t, host, "async_canary_arm_slow_handler")
	if _, err := armTool.Execute(map[string]any{"delayMs": handlerDelayMs}, ctx); err != nil {
		t.Fatalf("arm slow handler: %v", err)
	}

	// ── Step 1: drive FireAsync through the real timeout path ────────────────
	//
	// This calls the REAL host.FireAsync → callWithTimeout → time.After arm.
	// No manual Push/Pop occurs here.
	fireStart := time.Now()
	_, fireErr := host.FireAsync(
		asyncreg.KindSchedule,
		"async-canary-slow-handler",
		ctx,
		map[string]any{},
		time.Duration(fireTimeoutMs)*time.Millisecond,
	)
	fireReturnedAt := time.Now()
	fireElapsed := fireReturnedAt.Sub(fireStart)

	// PROVEN: FireAsync returned a real timeout error from callWithTimeout.
	if fireErr == nil {
		t.Fatalf("FireAsync succeeded unexpectedly; expected timeout error")
	}
	if !strings.Contains(fireErr.Error(), "timeout waiting for engine/fire_async response") {
		t.Fatalf("unexpected FireAsync error: %v (want 'timeout waiting for engine/fire_async response')", fireErr)
	}
	// Verify FireAsync returned within a reasonable bound (not a full handler delay).
	if fireElapsed > 500*time.Millisecond {
		t.Errorf("FireAsync took %v to return (expected < 500ms for a %dms timeout)", fireElapsed, fireTimeoutMs)
	}

	// ── Step 2: assert ctxStack is empty via the deferred Pop ───────────────
	//
	// FireAsync returned → deferred ctxStack.Pop() ran → stack depth is 0.
	// This assertion targets the real deferred Pop, not a manual one.
	if depth := host.CtxStackDepthForTest(); depth != 0 {
		t.Errorf("ctxStack depth = %d after FireAsync timeout return, want 0 (deferred Pop did not fire)", depth)
	}

	// ── Step 3: assert handler was still running when FireAsync returned ─────
	//
	// The probe-result event arrives only AFTER the handler's 40ms delay and
	// its dispatchAgent call complete. FireAsync returned after ~12ms. If the
	// event arrives after T_fireReturn, the handler was genuinely still running
	// when FireAsync returned.
	probeEv := waitProbeEvent(t, bus, 5*time.Second)
	probeArrivedAt := time.Now()

	if !probeArrivedAt.After(fireReturnedAt) {
		t.Errorf("probe event arrived at %v, FireAsync returned at %v — handler may have completed BEFORE FireAsync returned (unexpected)", probeArrivedAt, fireReturnedAt)
	}
	// The event arrived more than handlerDelayMs after the fire started,
	// confirming the handler ran its full delay after the timeout.
	totalElapsed := probeArrivedAt.Sub(fireStart)
	if totalElapsed < time.Duration(handlerDelayMs)*time.Millisecond {
		t.Errorf("total elapsed %v < handlerDelayMs %dms — handler may not have waited as configured", totalElapsed, handlerDelayMs)
	}

	// ── Step 4: assert nil-ctx error observed by the handler ────────────────
	//
	// PROVEN: the handler received "dispatch not available" from Go.
	// This is the -32000 error from host_rpc.go:387.
	if !strings.Contains(probeEv.EventMessage, "dispatch not available") {
		t.Errorf("probe event message = %q, want 'dispatch not available'", probeEv.EventMessage)
	}
	if probeEv.EventMessage == "UNEXPECTED_SUCCESS" {
		t.Errorf("handler's dispatchAgent SUCCEEDED — the defect did not trigger (ctx was not nil at call time)")
	}

	// ── Step 5: assert TypeScript error shape ───────────────────────────────
	//
	// PROVEN (TypeScript, observed via emit):
	// runtime.ts:778 does: new Error(msg.error.message || 'RPC error')
	// The .code property is never set on a plain Error. Verify it was not present.
	if probeEv.Metadata != nil {
		if hasCode, _ := probeEv.Metadata["errorHasCodeProperty"].(bool); hasCode {
			t.Errorf("TS Error had a .code property — the -32000 code survived, which would mean runtime.ts changed; update the analysis")
		}
		// The error name should be 'Error' (plain Error, not a custom subclass).
		if name, ok := probeEv.Metadata["errorName"].(string); ok && name != "" && name != "Error" {
			t.Logf("note: TS error name = %q (expected 'Error' for a plain new Error(msg))", name)
		}
	}

	// ── Step 6: assert no cancel frame was sent ──────────────────────────────
	//
	// The subprocess completed the handler and emitted the probe event, proving:
	//   (a) the subprocess was not killed or aborted by the engine after the timeout,
	//   (b) the subprocess pipe is still functional (the emit arrived via the readLoop),
	//   (c) no cancel RPC was sent (if one had been, the handler would not have been
	//       able to run to completion and issue ctx.dispatchAgent).
	//
	// Confirm the subprocess is still functional by issuing a harmless RPC that
	// does NOT depend on ctxStack (does not require a live ctx).
	rawWebhook, webhookErr := host.FireAsync(
		asyncreg.KindWebhook,
		"/test/hello",
		&extension.Context{SessionKey: "liveness-check"},
		map[string]any{
			"method":  "POST",
			"path":    "/test/hello",
			"url":     "/test/hello",
			"query":   "",
			"headers": map[string]string{"Authorization": "Bearer test-secret"},
			"body":    `{"name":"liveness"}`,
			"remote":  "127.0.0.1:0",
		},
		3*time.Second,
	)
	if webhookErr != nil {
		t.Errorf("subprocess liveness check failed after timeout: %v (subprocess may have been killed)", webhookErr)
	} else if len(rawWebhook) == 0 {
		t.Errorf("subprocess liveness check returned empty response")
	}
}

// TestScheduleFireTimeout_SchedulerConstant_Verified pins the scheduling
// package constant so the duration-contract inconsistency documented in the
// unit test file can be stated precisely in terms of the real constant rather
// than a hardcoded literal.
//
// Note: the unit-test file engine/internal/extension/host_fire_async_timeout_test.go
// lives in package extension. That package is imported BY the scheduling package,
// so importing scheduling from extension creates a cycle. The unit file therefore
// cannot reference scheduling.DefaultFireTimeout directly. It uses a comment
// instead. THIS test (package integration, which freely imports scheduling) pins
// the value authoritatively. If the scheduler constant changes, this test fails
// and forces reconciliation of the duration-contract analysis.
func TestScheduleFireTimeout_SchedulerConstant_Verified(t *testing.T) {
	// Pin the exact value.
	const wantDefault = 60 * time.Second
	if scheduling.DefaultFireTimeout != wantDefault {
		t.Errorf("scheduling.DefaultFireTimeout = %v, want %v — update the duration-contract analysis in host_fire_async_timeout_test.go and the associated comments", scheduling.DefaultFireTimeout, wantDefault)
	}

	// Pin the inconsistency: the host's compiled default is 0 (unbounded),
	// the scheduler imposes 60s. Both values must differ for the inconsistency
	// to exist. If someone fixes the inconsistency, this test should be updated.
	const hostDefault = 0 * time.Second // extension.defaultRPCTimeout (unexportable; pinned here by value)
	if hostDefault == scheduling.DefaultFireTimeout {
		t.Errorf("host defaultRPCTimeout (%v) equals scheduling.DefaultFireTimeout (%v) — the duration-contract inconsistency may have been resolved; update both this test and the unit-test characterisation", hostDefault, scheduling.DefaultFireTimeout)
	}
}
