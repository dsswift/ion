package extension

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ctxStack is a concurrency-safe stack of extension Contexts. It
// replaces the former single-slot atomic.Pointer[Context] to handle
// concurrent tool/hook/async-fire executions on CliBackend.
//
// On ApiBackend, at most one context is active at a time (serial
// execution), so the stack has depth 0 or 1 (identical behavior to
// the old atomic pointer). On CliBackend, the ToolServer may invoke
// multiple tool handlers concurrently while hooks fire on other
// goroutines. Each pushes its own Context; Current() returns the most
// recently pushed (top of stack). All contexts for the same session
// are functionally equivalent (same DispatchAgent, Emit, etc.), so
// "top of stack" is always a valid context for nested ext/* RPCs.
//
// Extracted from host.go per the engine/AGENTS.md "same-package
// multi-file is the idiom" rule and the precedent of host_async.go,
// host_dispose.go, host_fire_async.go, etc. The `Host` struct's
// `ctxStack` field declaration stays on the Host type in host.go; this
// file owns the ctxStack type and its operations.
type ctxStack struct {
	mu    sync.Mutex
	stack []*Context
}

// Push adds a context to the top of the stack.
//
// Invariant guard: every Context pushed on a given Host's stack must
// belong to the same engine session. The documented "all contexts for
// the same session are functionally equivalent" assumption is what
// makes Current() (top-of-stack) a valid choice for nested ext/* RPCs;
// if a different session's ctx ever lands on the stack, Current()
// could hand a nested RPC the wrong session's DispatchAgent / Emit and
// silently route work to the wrong session.
//
// Today this cannot happen: every push site routes through
// m.newExtContext(s, key) with one session per Host. The guard fires
// only if a future change violates the invariant. Logging an Error is
// the right severity — this is a "should never happen" condition, the
// kind of class root AGENTS.md §logging-policy classifies as an
// "invariant violation".
//
// The guard does NOT refuse the push (no return value to refuse with;
// callers of Push expect it to succeed). It only logs.
func (cs *ctxStack) Push(ctx *Context) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if n := len(cs.stack); n > 0 && cs.stack[n-1] != nil && ctx != nil {
		if cs.stack[n-1].SessionKey != ctx.SessionKey && cs.stack[n-1].SessionKey != "" && ctx.SessionKey != "" {
			utils.Error("extension", fmt.Sprintf(
				"ctxStack invariant violated: pushing ctx for session %q over %q (stack depth %d). "+
					"This indicates a bug — every ctx on a Host's stack must belong to the same session.",
				ctx.SessionKey, cs.stack[n-1].SessionKey, n))
		}
	}
	cs.stack = append(cs.stack, ctx)
}

// Pop removes the topmost context from the stack. Safe to call on an
// empty stack (no-op).
func (cs *ctxStack) Pop() {
	cs.mu.Lock()
	if n := len(cs.stack); n > 0 {
		cs.stack[n-1] = nil // release for GC
		cs.stack = cs.stack[:n-1]
	}
	cs.mu.Unlock()
}

// Current returns the topmost context, or nil when the stack is empty.
func (cs *ctxStack) Current() *Context {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if n := len(cs.stack); n > 0 {
		return cs.stack[n-1]
	}
	return nil
}
