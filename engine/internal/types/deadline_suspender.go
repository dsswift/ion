package types

import (
	"context"
	"sync"
	"time"
)

// DeadlineSuspender controls the finite execution deadline of a single tool
// call so it can be temporarily suspended while that tool is blocked waiting on
// a human through an elicitation request (ctx.elicit()).
//
// Motivation: a tool call is wrapped in a finite per-tool timeout (the engine's
// belt-and-suspenders backstop against a runaway tool). But an extension tool's
// execute() may synchronously call ctx.elicit(), which is an INDEFINITE
// human-wait. Without suspension, the finite tool deadline would cap that
// human-wait (and sever it messily). Suspending the deadline for exactly the
// span the tool is blocked on the human preserves the indefinite-human-wait
// guarantee while still bounding all actual machine work with the finite
// ceiling.
//
// Scope: only ctx.elicit() flows through this suspender (see
// sessionAccessor.Elicit, the sole Pause/Resume caller). Interactive permission
// prompts do NOT — the API backend's permEng.Check() returns synchronously
// (allow/deny/ask is a policy decision, not a blocking human-wait), and the CLI
// backend blocks for the human in its own permission_hook_server HTTP handler,
// which is bounded by the request context, not by the tool deadline. Permission
// blocking therefore has its own indefinite-wait safety and needs no suspension
// here.
//
// The mechanism is reference-counted so nested or sequential human-waits within
// one tool call behave correctly: the deadline is suspended on the first Pause
// and only re-armed (for the remaining machine work) when the matching final
// Resume lands. A nil *deadlineSuspender is a safe no-op, so paths that never
// installed one (or test contexts) call Pause/Resume unconditionally.
type DeadlineSuspender interface {
	// Pause suspends the finite deadline. While suspended, only lifecycle
	// cancellation (session abort / run teardown via the parent context)
	// can cancel the tool. Reference-counted with Resume.
	Pause()
	// Resume re-arms the finite deadline for the remaining work once the
	// reference count returns to zero. Each Pause must be matched by exactly
	// one Resume; callers should `defer Resume()` immediately after Pause().
	Resume()
}

// DeadlineSuspenderHandle is the concrete reference-counted suspender. It owns
// a resettable timer that, on fire, cancels the tool's context. Pausing stops
// the timer; resuming (at refcount 0) starts a fresh full-duration timer so the
// remaining machine work gets the entire finite budget again — a tool that does
// work, waits on a human for an hour, then does more work, must not have its
// post-wait work starved by time already elapsed before the wait.
//
// It implements DeadlineSuspender (Pause/Resume) and additionally exposes Stop,
// which the run loop calls when the tool completes to release the timer. The
// handle is returned as a concrete pointer (not the interface) so the run loop
// can call Stop; the interface is what flows on the context to the elicit /
// permission paths, which only need Pause/Resume.
type DeadlineSuspenderHandle struct {
	mu       sync.Mutex
	timeout  time.Duration
	cancel   context.CancelFunc
	timer    *time.Timer
	paused   int // reference count of outstanding Pause calls
	finished bool
	fired    bool // true when this suspender's own deadline fired the cancel
}

// NewDeadlineSuspender wires a suspender to a tool context's cancel func. It
// starts the finite deadline immediately (matching context.WithTimeout). Call
// Stop when the tool completes to release the timer. Returns nil if timeout is
// non-positive (an infinite/lifecycle-only tool such as the Agent tool needs no
// suspender — it has no finite deadline to suspend).
func NewDeadlineSuspender(timeout time.Duration, cancel context.CancelFunc) *DeadlineSuspenderHandle {
	if timeout <= 0 {
		return nil
	}
	ds := &DeadlineSuspenderHandle{
		timeout: timeout,
		cancel:  cancel,
	}
	ds.timer = time.AfterFunc(timeout, ds.fire)
	return ds
}

func (ds *DeadlineSuspenderHandle) fire() {
	ds.mu.Lock()
	if ds.finished || ds.paused > 0 {
		ds.mu.Unlock()
		return
	}
	ds.finished = true
	ds.fired = true
	cancel := ds.cancel
	ds.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Fired reports whether this suspender's own deadline fired (cancelling the
// tool), as opposed to the tool context being cancelled by an external cause
// (session abort / run teardown). The run loop uses this to surface a clear
// "tool exceeded its deadline" result instead of a generic cancellation — the
// distinction the context's own Err() can no longer make, because the suspender
// cancels via WithCancel rather than WithTimeout. Nil-safe (returns false).
func (ds *DeadlineSuspenderHandle) Fired() bool {
	if ds == nil {
		return false
	}
	ds.mu.Lock()
	defer ds.mu.Unlock()
	return ds.fired
}

// Pause suspends the deadline (reference-counted).
func (ds *DeadlineSuspenderHandle) Pause() {
	if ds == nil {
		return
	}
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.paused++
	if ds.paused == 1 && ds.timer != nil {
		ds.timer.Stop()
	}
}

// Resume re-arms the deadline when the last outstanding Pause is released.
func (ds *DeadlineSuspenderHandle) Resume() {
	if ds == nil {
		return
	}
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if ds.paused == 0 {
		return // defensive: unmatched Resume is a no-op
	}
	ds.paused--
	if ds.paused == 0 && !ds.finished {
		// Re-arm with the full timeout so post-wait machine work gets the
		// entire finite budget, not the remainder after the human-wait.
		ds.timer = time.AfterFunc(ds.timeout, ds.fire)
	}
}

// Stop releases the timer when the tool call completes. Idempotent. Safe on a
// nil receiver so the run loop can `defer handle.Stop()` unconditionally.
func (ds *DeadlineSuspenderHandle) Stop() {
	if ds == nil {
		return
	}
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.finished = true
	if ds.timer != nil {
		ds.timer.Stop()
	}
}

// --- Context threading (mirrors timeouts.go's WithTimeouts/TimeoutsFrom) ---

type deadlineSuspenderKey struct{}

// WithDeadlineSuspender stores a DeadlineSuspender in the context so the
// elicitation / permission paths reached through tool execution can suspend the
// tool's finite deadline while blocked on a human.
func WithDeadlineSuspender(ctx context.Context, ds DeadlineSuspender) context.Context {
	return context.WithValue(ctx, deadlineSuspenderKey{}, ds)
}

// DeadlineSuspenderFrom retrieves a DeadlineSuspender from the context. Returns
// nil if none is set; nil is a safe no-op (Pause/Resume on a nil
// *deadlineSuspender do nothing), so callers invoke it unconditionally.
func DeadlineSuspenderFrom(ctx context.Context) DeadlineSuspender {
	ds, _ := ctx.Value(deadlineSuspenderKey{}).(DeadlineSuspender) //nolint:errcheck // best-effort; failure not actionable here
	return ds
}
