package extension

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ctxStack is a concurrency-safe stack of extension Contexts. It
// replaces the former single-slot atomic.Pointer[Context] to handle
// concurrent tool/hook/async-fire executions on ClaudeCodeBackend.
//
// On ApiBackend, at most one context is active at a time (serial
// execution), so the stack has depth 0 or 1 (identical behavior to
// the old atomic pointer). On ClaudeCodeBackend, the ToolServer may invoke
// multiple tool handlers concurrently while hooks fire on other
// goroutines. Each pushes its own Context; Current() returns the most
// recently pushed (top of stack).
//
// "Top of stack" is a valid answer for a nested ext/* RPC only because every
// Context pushed on one Host is interchangeable in the fields those RPCs read.
// That holds by construction, and it is narrower than it looks — it is worth
// stating precisely, because a violation is silent:
//
//   - Same session: guarded in Push below.
//   - Same dispatch identity (Depth / DispatchId): every context reaching a
//     ROOT host is built by Manager.newExtContext* with no ExtContextOpts, so
//     it is always depth 0 with an empty DispatchId. Every context carrying a
//     depth > 0 targets a DISPATCHED CHILD's host, and each dispatched child
//     gets its own extension.NewHost() (loadChildExtension) and therefore its
//     own ctxStack. So one host never mixes depths.
//   - Same DispatchRegistry: this one was NOT always true. The registry used to
//     be an optional NewExtContext argument, and the agent_start / agent_end /
//     before_provider_request contexts omitted it. Those get pushed here for
//     the duration of a blocking hook RPC, so a concurrent ext/dispatch_agent
//     resolved against a registry-less context and its dispatch silently
//     skipped reserve/register — the sweep then deleted its live agent-state
//     slot and the orchestrator was never revived. The registry is now a
//     required positional parameter of NewExtContext, which makes that state
//     unrepresentable rather than merely unlikely.
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
// belong to the same engine session. The interchangeability argument in
// the type comment above is what makes Current() (top-of-stack) a valid
// choice for nested ext/* RPCs; if a different session's ctx ever lands
// on the stack, Current() could hand a nested RPC the wrong session's
// DispatchAgent / Emit and silently route work to the wrong session.
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
		utils.LogWithFields(utils.LevelError, "extension", "ctx stack invariant violated pushing ctx for different session", map[string]any{
				"session_id": ctx.SessionKey, "reason": cs.stack[n-1].SessionKey, "count": n,
			})
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
