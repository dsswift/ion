package session

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// session_root_context.go — the per-session cancellation root.
//
// This file owns the lifecycle of engineSession.rootCtx / rootCancel: the
// single context.Context every cancellable operation in a session derives
// from. It exists as its own file (rather than in the allowlisted god file
// manager.go) per the file-organization rule that new code goes in a new
// file in the right package.
//
// The design intent — see the long comment on engineSession.rootCtx in
// types.go — is that one cancel call (SendAbort or StopSession) cascades to
// the backend run, every dispatched child agent's in-process context, and
// any in-flight ctx.llmCall(). Process-level kill (abortAllDescendants)
// stays as the leaf enforcement for child agents that are separate OS
// processes.

// newSessionRootContext initializes the session's cancellation root. Called
// from StartSession before any run or dispatch can be launched, so every
// descendant operation has a live parent to derive from.
//
// Derives from context.Background(): the session root is the top of the
// engine's per-session cancellation tree. It is deliberately not parented to
// a request- or run-scoped context — the session outlives any single run,
// and cancelling the root must abort the whole session's in-flight work, not
// just the current run.
func (s *engineSession) newSessionRootContext() {
	s.rootCtx, s.rootCancel = context.WithCancel(context.Background())
	utils.Debug("Session", "newSessionRootContext: root cancellation context created key="+s.key)
}

// rootContext returns the session's cancellation root. Never returns nil:
// test-constructed sessions that did not call newSessionRootContext fall
// back to context.Background() so callers can derive unconditionally without
// nil checks. Production sessions always have a real cancellable root.
func (s *engineSession) rootContext() context.Context {
	if s.rootCtx == nil {
		// Defensive: a session built directly in a test (not through
		// StartSession) has no root. Returning Background keeps derive
		// sites simple — they get an un-cancellable-by-abort context,
		// which matches the pre-tree behavior those tests already assume.
		utils.Debug("Session", "rootContext: no root context (test-constructed session?); returning Background key="+s.key)
		return context.Background()
	}
	return s.rootCtx
}

// cancelSessionRoot cancels the session's cancellation root, cascading to
// every descendant context (backend run, dispatched agents, in-flight
// llmCall). Idempotent and nil-safe: cancelling an already-cancelled context
// is a no-op, and a nil rootCancel (test-constructed session) is skipped.
//
// reason is logged for observability so a developer reconstructing an abort
// from logs alone can see which path (user abort vs. teardown) triggered the
// root cancellation.
func (s *engineSession) cancelSessionRoot(reason string) {
	if s.rootCancel == nil {
		utils.Debug("Session", "cancelSessionRoot: no root cancel (test-constructed session?); skipping key="+s.key+" reason="+reason)
		return
	}
	utils.Info("Session", "cancelSessionRoot: cancelling session root context key="+s.key+" reason="+reason)
	s.rootCancel()
}
