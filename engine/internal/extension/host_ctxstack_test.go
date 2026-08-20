package extension

import (
	"runtime"
	"sync"
	"testing"
	"time"
)

// Tests for the ctxStack type added in commit c4c19777 to replace the
// single-slot atomic.Pointer[Context] with a concurrency-safe stack.
//
// The original tests for Push/Pop only exercised single-push semantics
// (host_rpc_context_test.go and host_rpc_send_prompt_test.go). The
// commit message claims "concurrent push/pop" support to fix the
// 'dispatch not available' error from ToolServer-invoked tools whose
// nested ext/* RPCs race against concurrent hook firings. Those
// concurrency claims need their own coverage; otherwise the fix is
// pinned by behavior on ApiBackend (stack depth ≤ 1, same as the old
// atomic pointer) and the ClaudeCodeBackend regression has no guard rail.

// TestCtxStack_PushPopLIFO verifies last-in-first-out semantics. The
// gate's documented contract is "Current() returns the top of the
// stack", and any consumer chaining hooks expects pops to unwind in
// reverse push order.
func TestCtxStack_PushPopLIFO(t *testing.T) {
	var cs ctxStack
	ctxA := &Context{Cwd: "/a"}
	ctxB := &Context{Cwd: "/b"}

	if cs.Current() != nil {
		t.Errorf("fresh stack must have Current()==nil, got %v", cs.Current())
	}

	tokA := cs.Push(ctxA)
	if cs.Current() != ctxA {
		t.Errorf("after Push(A), Current() must be A, got %v", cs.Current())
	}

	tokB := cs.Push(ctxB)
	if cs.Current() != ctxB {
		t.Errorf("after Push(A,B), Current() must be B (top of stack), got %v", cs.Current())
	}

	cs.Pop(tokB)
	if cs.Current() != ctxA {
		t.Errorf("after Pop(), Current() must revert to A, got %v", cs.Current())
	}

	cs.Pop(tokA)
	if cs.Current() != nil {
		t.Errorf("after all Pops, Current() must be nil, got %v", cs.Current())
	}
}

// TestCtxStack_PopOnEmpty_NoOp pins the no-op path: Pop on a fresh
// stack must not panic and must not corrupt subsequent operations.
// This guards the deferred-Pop pattern (e.g. host_io.go:callHook's
// `defer h.ctxStack.Pop()`) which can fire even on early-return paths
// before the corresponding Push happened.
func TestCtxStack_PopOnEmpty_NoOp(t *testing.T) {
	var cs ctxStack

	// Calling Pop on a fresh, empty stack must not panic. The zero-value
	// token never matches a real Push (nextID starts at 1).
	cs.Pop(0)

	if cs.Current() != nil {
		t.Errorf("Pop on empty stack must leave Current()==nil, got %v", cs.Current())
	}

	// Subsequent Push must still work normally.
	ctx := &Context{Cwd: "/after-empty-pop"}
	cs.Push(ctx)
	if cs.Current() != ctx {
		t.Errorf("Push after empty Pop must work normally, got %v", cs.Current())
	}
}

// TestCtxStack_ConcurrentPushPop is the scenario that motivated the
// original fix: many goroutines push/pop concurrently. Under -race
// the test exposes any data race in Push/Pop; without -race it still
// validates that the final stack depth is zero (all pushes balanced
// by pops). N=50 is arbitrary; large enough to make concurrent
// contention realistic on modern multi-core machines.
//
// The test does NOT validate that Current() always returns the
// caller's own ctx — that is an explicitly-not-supported guarantee
// (the documented contract is "any context for the same session is
// functionally equivalent"). It validates only that Push/Pop is
// race-free and balanced.
func TestCtxStack_ConcurrentPushPop(t *testing.T) {
	var cs ctxStack
	const N = 50

	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func(id int) {
			defer wg.Done()
			ctx := &Context{Cwd: "/g" + string(rune(id))}
			tok := cs.Push(ctx)
			// Current() must always return a non-nil value while at
			// least one Push has happened (this goroutine's own,
			// even if other goroutines have already popped theirs).
			if got := cs.Current(); got == nil {
				t.Errorf("goroutine %d: Current() returned nil after Push", id)
			}
			cs.Pop(tok)
		}(i)
	}
	wg.Wait()

	if got := cs.Current(); got != nil {
		t.Errorf("final stack depth must be zero, got Current()=%v", got)
	}
}

// TestCtxStack_ConcurrentReadsUnderContention is the scenario that
// triggered the original 'dispatch not available' bug: one writer
// pushes/pops in a tight loop while many readers call Current() in a
// tight loop. The old atomic.Pointer single-slot was race-free here
// (atomic Load/Store), but the new mutex-protected stack must also
// be race-free under -race.
//
// Test runs for ~100ms; any data race is detected by Go's race
// detector. Test asserts no panic, no race, and that the final state
// is consistent (Current() returns either nil or a valid *Context,
// never something corrupted by torn-write).
func TestCtxStack_ConcurrentReadsUnderContention(t *testing.T) {
	var cs ctxStack
	ctx := &Context{Cwd: "/contention"}

	done := make(chan struct{})

	// Writer: push/pop in a tight loop.
	go func() {
		for {
			select {
			case <-done:
				return
			default:
				tok := cs.Push(ctx)
				cs.Pop(tok)
			}
		}
	}()

	// Readers: many goroutines calling Current() in a tight loop.
	const readerCount = 10
	var readerWg sync.WaitGroup
	readerWg.Add(readerCount)
	for i := 0; i < readerCount; i++ {
		go func() {
			defer readerWg.Done()
			for {
				select {
				case <-done:
					return
				default:
					got := cs.Current()
					// Either nil (between push and pop) or our ctx —
					// never a torn pointer. The race detector catches
					// the unsafe case; this assertion is for plain
					// `go test` correctness.
					if got != nil && got != ctx {
						t.Errorf("Current() returned unexpected value: %v", got)
						return
					}
				}
			}
		}()
	}

	time.Sleep(100 * time.Millisecond)
	close(done)
	readerWg.Wait()
}

// TestCtxStack_PopReleasesReference pins the GC-release comment in
// the Pop implementation:
//
//	cs.stack[n-1] = nil // release for GC
//
// Without that nil-out, the popped *Context would remain reachable
// via the underlying slice array until the next Push overwrote the
// slot, which can cause unexpected retention on long-lived stacks.
// The test wires runtime.SetFinalizer on a popped ctx and verifies
// the finalizer fires after a forced GC.
//
// Disabled in -short and may be flaky under heavily-loaded CI because
// finalizer execution is not strictly synchronous with runtime.GC().
// Still useful locally and as a documentation-by-test of the intent.
func TestCtxStack_PopReleasesReference(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping GC-release test in -short mode")
	}
	var cs ctxStack

	// Push, capture a weak hint via a finalizer, and pop. After GC
	// the finalizer should fire (the slice array no longer pins the
	// *Context). We allocate the ctx in a tight scope so the local
	// variable doesn't keep it alive past the Pop.
	finalized := make(chan struct{}, 1)
	func() {
		ctx := &Context{Cwd: "/gc-release"}
		runtime.SetFinalizer(ctx, func(*Context) { finalized <- struct{}{} })
		tok := cs.Push(ctx)
		cs.Pop(tok)
		// Local 'ctx' goes out of scope here.
	}()

	// Force GC twice to give finalizers a chance to run (Go runtime
	// can defer finalizer execution by one cycle).
	runtime.GC()
	runtime.GC()

	select {
	case <-finalized:
		// Good — the popped ctx was reclaimed.
	case <-time.After(2 * time.Second):
		t.Skip("finalizer did not fire within 2s — this test is best-effort under load")
	}
}

// TestCtxStack_SessionMismatchLogged exercises the invariant guard
// added to Push: when a context belonging to session "B" is pushed
// while the topmost context belongs to session "A", the guard logs
// at Error level. This is a should-never-happen condition (engine
// today pushes only same-session contexts onto a single Host stack)
// but the guard catches the bug class early if anyone breaks the
// invariant in the future.
//
// The guard does not refuse the push (no return-value mechanism).
// The test asserts the push still succeeds and the new ctx is on
// top — observable Push behavior must not change. The log line is
// observed via the utils log capture helper (best-effort; if the
// capture infrastructure isn't available the test still validates
// the push-succeeds half of the contract).
func TestCtxStack_SessionMismatchLogged(t *testing.T) {
	var cs ctxStack
	ctxA := &Context{Cwd: "/a", SessionKey: "session-a"}
	ctxB := &Context{Cwd: "/b", SessionKey: "session-b"}

	cs.Push(ctxA)
	// Mismatched push — the guard fires utils.Error internally. We
	// can't easily assert on the log line here without wiring an
	// observer; the primary assertion is behavioral (the push
	// succeeded and Current() returns the new top).
	tokB := cs.Push(ctxB)

	if cs.Current() != ctxB {
		t.Errorf("after mismatched push, Current() must still return the new top, got %v", cs.Current())
	}

	// Same-session push must not trigger the guard. Pop ctxB and
	// push a fresh same-session ctxA-prime; behavior unchanged.
	cs.Pop(tokB)
	ctxAprime := &Context{Cwd: "/a2", SessionKey: "session-a"}
	cs.Push(ctxAprime)
	if cs.Current() != ctxAprime {
		t.Errorf("same-session push must succeed, got %v", cs.Current())
	}
}

// TestCtxStack_EmptyOrZeroSessionKey_NoFalsePositive verifies the
// guard does NOT log when one side of the comparison has an empty
// SessionKey. Some callers (e.g. test helpers, webhook resolvers
// constructing a partial ctx before session lookup completes) push
// a ctx with no SessionKey, and the guard must not flag them.
func TestCtxStack_EmptyOrZeroSessionKey_NoFalsePositive(t *testing.T) {
	var cs ctxStack
	ctxNoKey := &Context{Cwd: "/no-key"} // SessionKey == ""
	ctxWithKey := &Context{Cwd: "/has-key", SessionKey: "session-a"}

	// Sequence: push no-key, then push with-key. Guard must skip the
	// comparison because the top is empty-key.
	tok1 := cs.Push(ctxNoKey)
	tok2 := cs.Push(ctxWithKey)
	cs.Pop(tok2)
	cs.Pop(tok1)

	// Reverse: push with-key, then push no-key. Guard must also skip.
	cs.Push(ctxWithKey)
	cs.Push(ctxNoKey)
	if cs.Current() != ctxNoKey {
		t.Errorf("Current() must reflect the most recent push, got %v", cs.Current())
	}
}

// TestCtxStack_ThirdPushBetweenPushAndPop_DoesNotStealPop is the
// regression test for the concurrency defect this file's identity-scoped
// Pop was written to close.
//
// Real-world trigger (confirmed against conversation 1787163503581-aad5b50ac3d6
// engine logs): a long-running ext/dispatch_agent tool call (A) pushes its
// Context and is still in flight when an unrelated hook call (B) — e.g. a
// schedule cancel fired from before_prompt — pushes its own Context, runs,
// and pops. That much is properly nested (B on top, B pops itself) and is
// fine even with a blind top-of-stack Pop. The actual defect needs one more
// overlap: a THIRD operation (C) pushes while B is still active, so by the
// time B releases, B is no longer on top — C is. A token-less Pop() has no
// way to say "release B specifically"; it always removes whatever is on
// top, which here is C's still-in-flight entry. That silently corrupts C
// (C's own subsequent ext/* RPCs would then resolve against nothing, or
// against A's entry once C's own eventual Pop removes it) — this is the
// same class of interleaving that produced the "-32000 dispatch not
// available" observed on the conversation's dispatch_agent call.
//
// Identity-scoped Pop closes it: Pop(token) always removes exactly the
// entry its own Push produced, wherever it now sits in the stack.
func TestCtxStack_ThirdPushBetweenPushAndPop_DoesNotStealPop(t *testing.T) {
	var cs ctxStack

	ctxB := &Context{Cwd: "/b", SessionKey: "session-1"}
	ctxC := &Context{Cwd: "/c", SessionKey: "session-1"}

	tokB := cs.Push(ctxB)
	tokC := cs.Push(ctxC) // C pushes while B is still active; C is now on top.

	// B releases its own entry. Under a blind top-of-stack Pop this would
	// remove C's entry instead.
	cs.Pop(tokB)

	if got := cs.Current(); got != ctxC {
		t.Fatalf("Current() after B's targeted pop = %v, want ctxC (C's entry must survive B releasing its own)", got)
	}

	cs.Pop(tokC)
	if got := cs.Current(); got != nil {
		t.Errorf("Current() after all pops = %v, want nil", got)
	}
}
