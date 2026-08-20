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
// Identity-scoped release (not blind top-of-stack pop): Push returns an
// opaque ctxToken, and Pop takes that token back. Pop removes exactly the
// entry it was handed — by scanning for its token, not by assuming it is
// still on top — and never touches any other entry. This matters because
// concurrent Push/Pop pairs from unrelated operations (a tool call, a hook
// firing, a FireAsync schedule/webhook dispatch) are not guaranteed to
// nest in strict LIFO order. A blind Pop() removes whatever is on top
// regardless of who pushed it: if operation A pushes, operation B pushes
// after it, and A returns (and pops) before B does, a blind Pop would
// evict B's still-in-use context instead of A's, leaving B to resolve
// Current() against the wrong (or, once enough interleavings compound,
// a nil) entry on its next ext/* RPC. That is the exact mechanism behind
// the "-32000 dispatch not available" defect characterized in
// host_fire_async_timeout_test.go and schedule_fire_timeout_test.go: it
// was previously pinned only for the FireAsync-timeout early-Pop case,
// but the same blind-pop hazard applies to ANY overlapping, non-nested
// Push/Pop pair on the same Host — including an ordinary tool-call Push
// racing an unrelated hook-call Push/Pop (e.g. a schedule cancel fired
// from before_prompt while a dispatch_agent tool call is still in
// flight). Identity-scoped Pop closes the whole hazard class: a Pop can
// only ever remove the one entry its own Push produced.
//
// Extracted from host.go per the engine/AGENTS.md "same-package
// multi-file is the idiom" rule and the precedent of host_async.go,
// host_dispose.go, host_fire_async.go, etc. The `Host` struct's
// `ctxStack` field declaration stays on the Host type in host.go; this
// file owns the ctxStack type and its operations.
type ctxStack struct {
	mu     sync.Mutex
	stack  []ctxStackEntry
	nextID uint64
}

// ctxToken identifies one Push call's entry so Pop can release exactly
// that entry regardless of where it now sits in the stack (or whether it
// has already been removed). The zero value never matches a real push
// (nextID starts counting at 1), so a caller that forgets to capture the
// token from Push and passes the zero value is a guaranteed no-op rather
// than an accidental pop of someone else's entry.
type ctxToken uint64

// ctxStackEntry pairs a pushed Context with the token that identifies it.
type ctxStackEntry struct {
	token ctxToken
	ctx   *Context
}

// Push adds a context to the top of the stack and returns a token that
// must be passed to Pop to release exactly this entry.
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
func (cs *ctxStack) Push(ctx *Context) ctxToken {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if n := len(cs.stack); n > 0 && cs.stack[n-1].ctx != nil && ctx != nil {
		if cs.stack[n-1].ctx.SessionKey != ctx.SessionKey && cs.stack[n-1].ctx.SessionKey != "" && ctx.SessionKey != "" {
			utils.LogWithFields(utils.LevelError, "extension", "ctx stack invariant violated pushing ctx for different session", map[string]any{
				"session_id": ctx.SessionKey, "reason": cs.stack[n-1].ctx.SessionKey, "count": n,
			})
		}
	}
	cs.nextID++
	token := ctxToken(cs.nextID)
	cs.stack = append(cs.stack, ctxStackEntry{token: token, ctx: ctx})
	return token
}

// Pop removes the entry identified by token, wherever it sits in the
// stack. Safe to call with an already-removed or zero-value token
// (no-op) — this can happen legitimately when a deferred Pop runs after
// the entry was already released some other way.
func (cs *ctxStack) Pop(token ctxToken) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	for i := len(cs.stack) - 1; i >= 0; i-- {
		if cs.stack[i].token == token {
			cs.stack = append(cs.stack[:i], cs.stack[i+1:]...)
			return
		}
	}
}

// Current returns the topmost context, or nil when the stack is empty.
func (cs *ctxStack) Current() *Context {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if n := len(cs.stack); n > 0 {
		return cs.stack[n-1].ctx
	}
	return nil
}
