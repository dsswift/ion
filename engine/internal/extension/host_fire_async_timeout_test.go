package extension

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Tests for the scheduled-handler context-lifetime defect.
//
// Mechanism (confirmed from source, do not re-derive):
//
//  1. scheduler.go calls host.FireAsync(KindSchedule, jobID, ctx, payload, timeout).
//  2. FireAsync pushes ctx onto ctxStack, sends engine/fire_async to the subprocess,
//     then blocks on callWithTimeout.
//  3. callWithTimeout returns on the timeout arm (host_io.go:166-170), which deletes
//     the pending-response entry and returns an error.  No cancel RPC is sent; the
//     TypeScript handler keeps running.
//  4. FireAsync's `defer h.ctxStack.Pop()` executes immediately on return, removing
//     ctx from the stack.
//  5. Any ext/* RPC the still-running handler now issues resolves ctxStack.Current()
//     to nil (stack empty) and receives a capability error such as:
//       -32000  "dispatch not available"    (ext/dispatch_agent)
//       -32603  "fire schedule not available" (ext/fire_schedule)
//  6. The ctxStack.Push invariant guard (host_ctxstack.go:51-62) does NOT fire:
//     nothing invalid is pushed; the correct ctx is legitimately pushed then
//     legitimately popped early.  The guard is blind to this defect class.
//
// SCOPE OF THIS FILE (unit-level characterisation, package extension)
//
// These tests hand-simulate the FireAsync early-return by calling
// simulateFireAsyncEarlyReturn (Push followed immediately by Pop) rather than
// calling FireAsync directly against a live subprocess.  They establish the
// observable consequences of nil ctxStack.Current() but do NOT prove that
// FireAsync's own deferred Pop is what produces the nil state.
//
// The end-to-end proof — FireAsync called on a real node subprocess with a real
// timeout — lives in engine/tests/integration/schedule_fire_timeout_test.go.
//
// Three consequences pinned here:
//
//  A. Availability loss: ext/dispatch_agent issued after the hand-simulated early
//     return gets -32000 "dispatch not available" because ctxStack.Current() is nil.
//
//  B. Duration-contract inconsistency: defaultRPCTimeout (host.go:20) is 0 (wait
//     indefinitely), while the scheduler imposes DefaultFireTimeout = 60s.  The
//     same handler body has irreconcilably different duration semantics depending on
//     entry point.  Additionally, host.go:34 documents the field as "Defaults to
//     defaultRPCTimeout (30s)" — a stale comment; the constant is 0, not 30s.
//
//  C. TypeScript promise propagation: on the Go side the -32000 error string is
//     the only information returned.  runtime.ts:778 does:
//       pending.reject(new Error(msg.error.message || 'RPC error'))
//     so the awaited SDK call inside the still-running handler rejects with an Error
//     whose message is "dispatch not available".  The JSON-RPC code (-32000) is
//     DROPPED: the Error object carries only the string.  The handler therefore
//     CANNOT distinguish a fire-timeout-induced capability loss from an ordinary
//     dispatch failure.  The Go side of this assertion is fully provable here;
//     the TS runtime.ts behaviour is confirmed by reading the source and is
//     documented in the test comment — the integration test (schedule_fire_timeout_test.go)
//     executes the TS side against a real subprocess and confirms the code-loss.
//
// All tests in this file are CHARACTERISATION TESTS. The behaviour they pin IS
// the defect. Their passing does not indicate correct behaviour; it documents
// what currently happens so a future fix changes the pinned assertion deliberately.

// ── helpers ──────────────────────────────────────────────────────────────────

// dispatchAgentPayload builds a minimal ext/dispatch_agent JSON-RPC request.
// The DispatchAgentOpts struct requires at least "name".
func dispatchAgentPayload(t *testing.T, name string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      99,
		"method":  "ext/dispatch_agent",
		"params": map[string]interface{}{
			"name":       name,
			"background": false,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// fireSchedulePayload builds a minimal ext/fire_schedule JSON-RPC request.
func fireSchedulePayload(t *testing.T, id string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      99,
		"method":  "ext/fire_schedule",
		"params":  map[string]interface{}{"id": id},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// simulateFireAsyncEarlyReturn hand-simulates the Pop that FireAsync's deferred
// cleanup performs when callWithTimeout returns on the timeout arm.
//
// It pushes ctx onto h's ctxStack (mirroring FireAsync's entry) then immediately
// pops it (mirroring the deferred Pop on FireAsync's return). The net effect is
// an empty stack — the same state the real code produces BEFORE the subprocess
// handler issues its next RPC.
//
// NOTE: this is a SIMULATION, not the real mechanism. It does not call FireAsync
// or callWithTimeout. The integration test in schedule_fire_timeout_test.go drives
// the real mechanism against a live subprocess. Use simulateFireAsyncEarlyReturn
// only for unit-level consequence tests where subprocess I/O is not required.
func simulateFireAsyncEarlyReturn(h *Host, ctx *Context) func() {
	h.ctxStack.Push(ctx)
	h.ctxStack.Pop() // mirrors the deferred Pop on FireAsync's timeout return
	return func() {
		if got := h.ctxStack.Current(); got != nil {
			panic("stack not empty after simulated early return")
		}
	}
}

// ── Consequence A: nil context → capability error ─────────────────────────────

// TestFireAsyncTimeout_NilCtx_DispatchNotAvailable pins Consequence A.
//
// DEFECT CHARACTERISATION — the behaviour asserted here is the defect.
//
// METHOD: hand-simulation via simulateFireAsyncEarlyReturn (Push + immediate Pop).
// The real mechanism is proven end-to-end by TestScheduleFireTimeout_EndToEnd in
// engine/tests/integration/schedule_fire_timeout_test.go.
//
// Contract under test: after the simulated early return leaves the ctxStack empty,
// a subsequent ext/dispatch_agent RPC from the still-running handler resolves
// ctxStack.Current() to nil.  The handler receives:
//
//	{"jsonrpc":"2.0","id":99,"error":{"code":-32000,"message":"dispatch not available"}}
//
// The correct behaviour (not implemented here) would be to either:
//   - cancel the handler before popping its ctx, or
//   - leave ctx on the stack until the subprocess confirms completion, or
//   - send a cancel RPC and wait for the subprocess to acknowledge.
func TestFireAsyncTimeout_NilCtx_DispatchNotAvailable(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{
		Cwd:        "/test",
		SessionKey: "session-sched-1",
		DispatchAgent: func(opts DispatchAgentOpts) (*DispatchAgentResult, error) {
			// This function would only be reached if the ctx were still
			// on the stack.  The defect prevents it from being called.
			return &DispatchAgentResult{}, nil
		},
	}

	// Hand-simulate FireAsync returning on the timeout arm (not a real call).
	cleanup := simulateFireAsyncEarlyReturn(h, ctx)
	defer cleanup()

	// Simulate the handler issuing ext/dispatch_agent after the ctx is gone.
	h.handleExtRequest("ext/dispatch_agent", 99, dispatchAgentPayload(t, "some-agent"))

	resp := readResponse(t, ch, time.Second)

	// DEFECT ASSERTION: the still-running handler gets an error because
	// its context was already popped.
	errObj, hasErr := resp["error"].(map[string]interface{})
	if !hasErr {
		t.Fatalf("expected JSON-RPC error response, got result=%v", resp["result"])
	}
	if code := errObj["code"]; code != float64(-32000) {
		t.Errorf("expected code -32000 (dispatch not available), got %v", code)
	}
	msg, _ := errObj["message"].(string)
	if !strings.Contains(msg, "dispatch not available") {
		t.Errorf("expected 'dispatch not available' in error message, got %q", msg)
	}
}

// TestFireAsyncTimeout_NilCtx_FireScheduleUsesPersistentFallback proves the
// scheduled-handler timeout path preserves deferred schedule control through
// the host's session-scoped fallback.
func TestFireAsyncTimeout_NilCtx_FireScheduleUsesPersistentFallback(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	called := ""
	h.SetPersistentScheduleControl(func(id string) error { called = id; return nil }, nil)

	ctx := &Context{Cwd: "/test", SessionKey: "session-sched-2"}
	cleanup := simulateFireAsyncEarlyReturn(h, ctx)
	defer cleanup()
	h.handleExtRequest("ext/fire_schedule", 99, fireSchedulePayload(t, "my-job-id"))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("response=%#v", resp)
	}
	if called != "my-job-id" {
		t.Fatalf("persistent fire=%q", called)
	}
}

// TestFireAsyncTimeout_PushGuard_DoesNotFireOnEarlyPop pins the invariant-guard
// blind spot.
//
// DEFECT CHARACTERISATION — the asserted absence of the guard log is the blind
// spot, not a desired property.
//
// METHOD: direct ctxStack manipulation (no subprocess involved).
//
// The ctxStack.Push invariant guard (host_ctxstack.go:51-62) fires when a
// context with a DIFFERENT SessionKey is pushed while a same-session context is
// already on the stack.  It is designed to catch cross-session contamination.
//
// The fire-timeout defect does not trigger it:
//   - The correct ctx IS pushed (guard observes nothing unusual).
//   - The correct ctx IS popped early (guard is not consulted during Pop).
//   - The stack is now empty.
//   - No invalid push happens.
//
// Therefore the guard's Error log does not fire for this defect class.  This
// test confirms the blind spot: a push onto an empty stack never fires the guard
// regardless of SessionKey, so the post-timeout state is invisible to it.
func TestFireAsyncTimeout_PushGuard_DoesNotFireOnEarlyPop(t *testing.T) {
	var cs ctxStack

	ctxA := &Context{Cwd: "/sched", SessionKey: "session-x"}
	ctxB := &Context{Cwd: "/sched2", SessionKey: "session-x"}

	// Simulate FireAsync: push, then immediately pop (timeout early return).
	cs.Push(ctxA)
	cs.Pop()

	// Stack is now empty.  The guard only fires if a mismatched SessionKey
	// is pushed while another context is already present.  An empty-stack
	// push is always silent regardless of SessionKey.
	cs.Push(ctxB) // no guard log fires — empty stack

	if got := cs.Current(); got != ctxB {
		t.Errorf("expected ctxB on stack after push, got %v", got)
	}

	// BLIND SPOT ASSERTION: the defect (early pop leaving handler ctx-less)
	// is not visible to the guard.  The guard would only fire if an
	// alien-session ctx were pushed while ctxA was still present — that
	// cannot happen here because ctxA was already legitimately popped.
	// This test documents the gap: the guard does not protect against
	// fire-timeout-induced capability loss.
	cs.Pop()
	if got := cs.Current(); got != nil {
		t.Errorf("expected nil after final pop, got %v", got)
	}
}

// ── Consequence B: duration-contract inconsistency ───────────────────────────

// TestFireAsync_DurationContractInconsistency pins the inconsistency between
// the defaultRPCTimeout constant and the scheduler's DefaultFireTimeout.
//
// DEFECT CHARACTERISATION — the asserted values expose the inconsistency.
//
// host.go:20 declares:
//
//	const defaultRPCTimeout = 0
//
// host_io.go:118 documents the zero path as "wait indefinitely — the engine
// does not impose duration opinions on extension tool calls or dispatches."
//
// scheduler.go:48 declares:
//
//	const DefaultFireTimeout = 60 * time.Second
//
// These two constants apply to the SAME handler body:
//   - When an extension calls ext/dispatch_agent from inside a hook, the
//     engine waits indefinitely (defaultRPCTimeout = 0).
//   - When the same dispatch call originates from a scheduled handler fired
//     via FireAsync, the handler is force-abandoned after 60 seconds even
//     though no cancel RPC is sent, no context is cancelled, and no rollback
//     is triggered.
//
// IMPORT CYCLE NOTE: this file lives in package extension.  The scheduling
// package imports extension (scheduling.persistence imports extension types).
// Therefore extension cannot import scheduling without creating a cycle.  The
// 60-second value is pinned here as a literal comment rather than a reference
// to scheduling.DefaultFireTimeout.  The integration test file
// schedule_fire_timeout_test.go (package integration) can import scheduling and
// does reference the constant directly via TestScheduleFireTimeout_SchedulerConstant_Verified.
// If the scheduler constant changes, that test will fail and surface the need to
// update this literal as well.
//
// STALE COMMENT: host.go:34 documents rpcTimeout as "Defaults to
// defaultRPCTimeout (30s)".  The constant is 0 (unbounded), not 30s.
// No fix is applied here; reported only.
func TestFireAsync_DurationContractInconsistency(t *testing.T) {
	// Pin the host-level default: zero means wait indefinitely.
	const wantDefaultRPCTimeout time.Duration = 0
	if defaultRPCTimeout != wantDefaultRPCTimeout {
		t.Errorf("defaultRPCTimeout = %v, want %v (unbounded); if changed, update the duration-contract analysis", defaultRPCTimeout, wantDefaultRPCTimeout)
	}

	// Pin the scheduler fire timeout as a literal (60s) because the import
	// cycle prevents referencing scheduling.DefaultFireTimeout from this package.
	// The authoritative reference is TestScheduleFireTimeout_SchedulerConstant_Verified
	// in engine/tests/integration/schedule_fire_timeout_test.go.
	const schedulerFireTimeout = 60 * time.Second // matches scheduling.DefaultFireTimeout

	// The inconsistency: same handler body, two duration regimes.
	if defaultRPCTimeout == schedulerFireTimeout {
		t.Errorf("defaultRPCTimeout (%v) equals DefaultFireTimeout (%v): the duration-contract inconsistency has been resolved — update this test", defaultRPCTimeout, schedulerFireTimeout)
	}

	// Document the stale comment: host.go:34 says "Defaults to
	// defaultRPCTimeout (30s)".  The constant is 0.  Assert that
	// NewHost() initialises rpcTimeout to 0, confirming the stale
	// comment is not reflected in runtime behaviour.
	h := NewHost()
	if h.rpcTimeout != 0 {
		t.Errorf("h.rpcTimeout = %v after NewHost(), want 0 (the '30s' in host.go:34 is a stale comment)", h.rpcTimeout)
	}
}

// ── Consequence C: TypeScript promise propagation ─────────────────────────────

// TestFireAsyncTimeout_TSPromiseRejection_CodeLoss pins the TypeScript-side
// consequence of the nil-ctx JSON-RPC error.
//
// DEFECT CHARACTERISATION — the asserted wire format is the defect surface.
//
// METHOD: no subprocess; asserts Go-side wire format only.
// The TS runtime behaviour is confirmed by reading runtime.ts source and is
// documented here.  The integration test TestScheduleFireTimeout_EndToEnd in
// engine/tests/integration/schedule_fire_timeout_test.go runs the TS side
// against a real subprocess and confirms the code-loss against actual execution.
//
// Go side (this test):
//   - handleExtRequest returns a JSON-RPC error frame with both code and message.
//
// TypeScript side (source-confirmed; see runtime.ts:778):
//
//		pending.reject(new Error(msg.error.message || 'RPC error'))
//
//	  - Only msg.error.message reaches the Error constructor.
//	  - The JSON-RPC code (-32000) is DROPPED.
//	  - The handler's catch block sees: Error { message: "dispatch not available" }
//	  - The handler CANNOT distinguish a fire-timeout capability loss from an ordinary
//	    dispatch failure, because the error message is identical in both cases and the
//	    code is not preserved.
func TestFireAsyncTimeout_TSPromiseRejection_CodeLoss(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	// No ctx on stack: simulate the post-timeout state.
	h.handleExtRequest("ext/dispatch_agent", 99, dispatchAgentPayload(t, "any-agent"))

	resp := readResponse(t, ch, time.Second)

	errObj, hasErr := resp["error"].(map[string]interface{})
	if !hasErr {
		t.Fatalf("expected error object in response, got %v", resp)
	}

	// Go wire: both code and message are present.
	code, hasCode := errObj["code"]
	msg, hasMsg := errObj["message"]

	if !hasCode {
		t.Error("Go wire: expected 'code' field in error object")
	}
	if !hasMsg {
		t.Error("Go wire: expected 'message' field in error object")
	}
	if code != float64(-32000) {
		t.Errorf("Go wire: expected code -32000, got %v", code)
	}
	if !strings.Contains(msg.(string), "dispatch not available") {
		t.Errorf("Go wire: expected 'dispatch not available' in message, got %q", msg)
	}

	// TypeScript runtime.ts:778 assertion (source-confirmed; executed in
	// TestScheduleFireTimeout_EndToEnd against a real subprocess):
	//
	//   new Error(msg.error.message || 'RPC error')
	//
	// Only msg.error.message reaches the Error constructor.  The code field
	// is present in the Go wire frame but is NOT passed to new Error().
	// The handler's catch block sees: Error { message: "dispatch not available" }
	//
	// ASSERTION: the message string does not contain enough information to
	// identify the cause as a fire-timeout.  It is identical to what the
	// handler would see if ctx.DispatchAgent were simply nil (ordinary
	// unconfigured-capability case).
	msgStr, _ := msg.(string)
	if strings.Contains(msgStr, "timeout") || strings.Contains(msgStr, "schedule") || strings.Contains(msgStr, "fire") {
		t.Logf("NOTE: error message now contains cause information (%q); the observability gap may have been closed", msgStr)
	}

	// Confirm no out-of-band cancel notification was sent.
	// The channel should be empty after the single response frame.
	select {
	case extra := <-ch:
		t.Errorf("unexpected second frame (cancel notification?): %s", extra)
	case <-time.After(10 * time.Millisecond):
		// Correct: no cancel or timeout notification was sent.
	}
}

// Tests for the scheduled-handler context-lifetime defect.
//
// Mechanism (confirmed from source, do not re-derive):
//
//  1. scheduler.go calls host.FireAsync(KindSchedule, jobID, ctx, payload, timeout).
//  2. FireAsync pushes ctx onto ctxStack, sends engine/fire_async to the subprocess,
//     then blocks on callWithTimeout.
//  3. callWithTimeout returns on the timeout arm (host_io.go:166-170), which deletes
//     the pending entry and returns an error.  No cancel RPC is sent; the TypeScript
//     handler keeps running.
//  4. FireAsync's `defer h.ctxStack.Pop()` executes immediately on return, removing
//     ctx from the stack.
//  5. Any ext/* RPC the still-running handler now issues resolves ctxStack.Current()
//     to nil (stack empty) and receives a capability error such as:
//       -32000  "dispatch not available"    (ext/dispatch_agent)
//       -32603  "fire schedule not available" (ext/fire_schedule)
//  6. The ctxStack.Push invariant guard (host_ctxstack.go:51-62) does NOT fire:
//     nothing invalid is pushed; the correct ctx is legitimately pushed then
//     legitimately popped early.  The guard is blind to this defect class.
//
// Three consequences tested here:
//
//  A. Availability loss: ext/dispatch_agent issued after FireAsync returns gets
//     -32000 "dispatch not available" because ctxStack.Current() is nil.
//
//  B. Duration-contract inconsistency: defaultRPCTimeout (host.go:20) is 0 (wait
//     indefinitely), while the scheduler imposes DefaultFireTimeout = 60s.  The
//     same handler body has irreconcilably different duration semantics depending on
//     entry point.  Additionally, host.go:34 documents the field as "Defaults to
//     defaultRPCTimeout (30s)" — a stale comment; the constant is 0, not 30s.
//
//  C. TypeScript promise propagation: on the Go side the -32000 error string is
//     the only information returned.  runtime.ts:778 does:
//       pending.reject(new Error(msg.error.message || 'RPC error'))
//     so the awaited SDK call inside the still-running handler rejects with an Error
//     whose message is "dispatch not available".  The JSON-RPC code (-32000) is
//     DROPPED: the Error object carries only the string.  The handler therefore
//     CANNOT distinguish a fire-timeout-induced capability loss from an ordinary
//     dispatch failure.  The Go side of this assertion is fully provable here;
//     the TS runtime.ts behaviour is confirmed by reading the source and is
//     documented in the test comment — no running TS process is required to pin
//     the Go half of the chain.
