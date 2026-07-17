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

	// Mint one stable trace ID per session (idempotent across re-arms: keep
	// the existing ID if this root is being re-created after an abort, so the
	// whole session shares a single trace).
	if s.traceID == "" {
		s.traceID = utils.NewTraceID()
	}

	// Thread the correlation IDs into the root so every descendant operation
	// that logs via utils.LogCtx(ctx, ...) automatically stamps session_id,
	// conversation_id, and trace_id. Omitted IDs (empty conversationID before
	// binding) are simply not carried; LogCtx omits absent IDs per the schema.
	s.rootCtx = utils.WithSessionID(s.rootCtx, s.key)
	if s.conversationID != "" {
		s.rootCtx = utils.WithConversationID(s.rootCtx, s.conversationID)
	}
	s.rootCtx = utils.WithTraceID(s.rootCtx, s.traceID)

	utils.LogWithFields(utils.LevelDebug, "session", "newsessionrootcontext: root cancellation context created key= trace_id=", map[string]any{"key": s.key, "run_id": s.traceID})
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
		utils.LogWithFields(utils.LevelDebug, "session", "rootcontext: no root context (test-constructed session?); returning background key=", map[string]any{"key": s.key})
		return context.Background()
	}
	return s.rootCtx
}

// rearmRootContextIfCancelled re-creates the session's cancellation root iff
// the current root is nil or already cancelled. It is the recovery counterpart
// to cancelSessionRoot: an abort (SendAbort) or a stalled-run cancellation
// permanently closes rootCtx, and because newSessionRootContext is only called
// once at StartSession, every subsequent run would otherwise derive its
// ParentCtx from that dead context and exit immediately with signal=cancelled.
// That wedged the session so badly the only fix was an engine restart (the
// 1782088921498-960b064fe896 incident: two `resume` attempts both exited
// instantly because the post-abort root was still cancelled).
//
// Re-arming here, at the start of each new dispatch, makes a session
// self-healing: after any abort the next prompt gets a live root and runs
// normally — no engine restart, ever.
//
// Idempotent and safe for the normal case: when the root is still live (Err()
// == nil), this is a no-op, so back-to-back prompts with no intervening abort
// keep the SAME root and never reparent in-flight descendants. The caller MUST
// hold the manager lock (every other rootCtx access does), and the new-run
// busy-guard upstream guarantees no run is in flight when this fires, so no
// live descendant is ever orphaned by the swap.
func (s *engineSession) rearmRootContextIfCancelled() {
	if s.rootCtx != nil && s.rootCtx.Err() == nil {
		// Still live — keep the existing root so in-flight descendants
		// (background dispatches, llmCalls) stay parented to it.
		utils.LogWithFields(utils.LevelDebug, "session", "rearmrootcontextifcancelled: root still live, no-op key=", map[string]any{"key": s.key})
		return
	}
	reason := "nil"
	if s.rootCtx != nil {
		reason = "cancelled"
	}
	utils.LogWithFields(utils.LevelInfo, "session", "rearmrootcontextifcancelled: re-creating session root (was ) key=", map[string]any{"reason": reason, "key": s.key})
	s.newSessionRootContext()
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
		utils.LogWithFields(utils.LevelDebug, "session", "cancelsessionroot: no root cancel (test-constructed session?); skipping key= reason=", map[string]any{"key": s.key, "reason": reason})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "cancelsessionroot: cancelling session root context key= reason=", map[string]any{"key": s.key, "reason": reason})
	s.rootCancel()
}
