package session

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// abort_scope.go — scoped session abort.
//
// The engine historically had exactly one stop verb: cancel the session
// cancellation root, which cascades to the backend run, every dispatched
// child's context, and any in-flight ctx.llmCall(), then reap descendants.
// That is the right behavior for "stop everything", but it is the ONLY
// behavior, so a consumer could not stop a stuck orchestrator while leaving
// its background dispatches to finish the work they were given.
//
// This file adds the scope dimension. The mechanism (cancellation, reaping,
// recall) is unchanged and still owned by the engine; the scope is the
// consumer's opinion about how much of the tree to tear down.

// AbortScope selects how much of a session's work an abort tears down.
//
// It is a wire-facing string (protocol.ClientCommand.AbortScope) rather than
// an enum so the set can grow additively without breaking a decoder. An
// unrecognized value resolves to AbortScopeAll — the safe interpretation of
// "stop", and the historical behavior.
type AbortScope string

const (
	// AbortScopeAll cancels the session cancellation root (cascading to the
	// run, every dispatch, and in-flight llmCalls), then recalls and reaps
	// every descendant. This is the default and the pre-scope behavior.
	AbortScopeAll AbortScope = "all"

	// AbortScopeAllWork additionally stops every session-owned background Bash
	// task while retaining the reusable session object.
	AbortScopeAllWork AbortScope = "all_work"

	// AbortScopeOrchestrator cancels ONLY the active run. The session
	// cancellation root is left live, so background dispatches keep running
	// and their eventual completion still routes back into the session.
	//
	// Foreground dispatches (the orchestrator's Agent tool, whose ParentCtx
	// is the per-tool-call context) are part of the orchestrator's turn and
	// stop with it under this scope too — they are the run, not peers of it.
	//
	// In-flight ctx.llmCall() one-shots also survive: they derive from the
	// session root and are shared by dispatch-side flows, so cancelling them
	// would be a tree-wide effect wearing a scoped label.
	AbortScopeOrchestrator AbortScope = "orchestrator"
)

// ParseAbortScope maps a wire value onto an AbortScope. Empty resolves to
// AbortScopeAll so clients that predate the field keep their behavior. An
// unrecognized value is logged before defaulting — a malformed scope is a
// caller bug worth seeing in the logs, never a silent reinterpretation.
//
// Exported because the server's command dispatch resolves the wire string
// before calling SendAbortScoped, so the string→scope mapping lives in one
// place rather than being re-derived per call site.
func ParseAbortScope(raw string) AbortScope {
	switch AbortScope(raw) {
	case "":
		return AbortScopeAll
	case AbortScopeAll:
		return AbortScopeAll
	case AbortScopeAllWork:
		return AbortScopeAllWork
	case AbortScopeOrchestrator:
		return AbortScopeOrchestrator
	default:
		utils.LogWithFields(utils.LevelWarn, "session", "parseabortscope: unknown scope, defaulting to all", map[string]any{
			"abort_scope": raw,
		})
		return AbortScopeAll
	}
}

// SendAbortScoped cancels the active run for the given session, tearing down
// as much of the surrounding tree as the scope asks for.
//
// Both scopes drop the prompt queue and cancel the backend run. They differ
// in what happens to everything else:
//
//   - AbortScopeAll cancels the session cancellation root and reaps every
//     descendant (recalling registry dispatches and killing agent processes).
//   - AbortScopeOrchestrator leaves the root live and marks the in-flight run
//     so handleRunExit skips its own descendant reap when this run unwinds.
//     Without that marker the reap at run exit would undo the scope: a
//     cancelled run always looks like a clean cancel there.
func (m *Manager) SendAbortScoped(key string, scope AbortScope) {
	utils.LogWithFields(utils.LevelInfo, "session", "sendabort", map[string]any{"key": key, "abort_scope": string(scope)})
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session", "sendabort: session not found for", map[string]any{"key": key, "abort_scope": string(scope)})
		return
	}
	rid := s.requestID
	// Discard any prompts queued behind the in-flight run. Pressing Stop
	// means "abandon the pending work", so prompts the user queued *before*
	// the abort must not be resurrected when the cancelled run unwinds and
	// handleRunExit drains the queue. This mirrors StopSession, which also
	// nils promptQueue. A prompt the user types *after* this abort re-queues
	// onto the now-empty queue and is dispatched once by handleRunExit's
	// existing drain — that is the intended hold-and-dispatch behavior.
	//
	// This holds for BOTH scopes: an orchestrator-scoped stop still means
	// "abandon the pending work" for the orchestrator, and the queue is the
	// orchestrator's, not the dispatches'.
	//
	// We deliberately do NOT clear s.requestID here: the run goroutine and
	// its cancel watchdog own the requestID lifecycle and clear it via
	// handleRunExit on real exit. Clearing it out from under them would
	// desync the backend's per-run watchdog / terminal-status contract and
	// risk a double dispatch.
	if dropped := len(s.promptQueue); dropped > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "sendabort: dropping queued prompt(s) for", map[string]any{"dropped": dropped, "key": key, "abort_scope": string(scope)})
		s.promptQueue = nil
	}
	// Mark the run so handleRunExit knows not to reap descendants when it
	// unwinds. Set under the same lock as the requestID read so the marker
	// and the run it names cannot drift. Cleared by handleRunExit (or by the
	// next orchestrator-scoped abort, which overwrites it with its own rid).
	if scope == AbortScopeOrchestrator {
		s.orchestratorAbortRunID = rid
		utils.LogWithFields(utils.LevelInfo, "session", "sendabort: marking run for no-reap exit (orchestrator scope)", map[string]any{"key": key, "run_id": rid})
	}
	m.mu.Unlock()

	if scope == AbortScopeAll || scope == AbortScopeAllWork {
		// Cancel the session's cancellation root first. This cascades through
		// the Go context tree to every descendant that derived from it — the
		// backend run (via RunOptions.ParentCtx), dispatched child agents'
		// in-process contexts, and any in-flight ctx.llmCall(). The explicit
		// backend.Cancel(rid) and abortAllDescendants calls below remain as
		// belt-and-suspenders: backend.Cancel drives the per-run watchdog /
		// terminal-status emission contract, and abortAllDescendants performs
		// the registry recall plus the OS-process kill that a context cancel
		// alone cannot do for child agents running as separate processes.
		s.cancelSessionRoot("user abort")
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "sendabort: leaving session root live (orchestrator scope)", map[string]any{"key": key})
	}

	if rid != "" {
		utils.LogWithFields(utils.LevelInfo, "session", "sendabort: cancelling for", map[string]any{"run_id": rid, "key": key, "abort_scope": string(scope)})
		m.backend.Cancel(rid)
	} else {
		utils.LogWithFields(utils.LevelWarn, "session", "sendabort: no active requestid for", map[string]any{"key": key, "abort_scope": string(scope)})
	}

	if scope == AbortScopeAll || scope == AbortScopeAllWork {
		// Always reap descendants — they may outlive the parent run.
		m.abortAllDescendants(key, "user abort")
		if scope == AbortScopeAllWork {
			m.stopBackgroundWork(key)
		}
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "sendabort: leaving background dispatches running (orchestrator scope)", map[string]any{"key": key})
	}
}

// AbortDispatch cancels ONE background dispatch by its unique dispatch ID,
// leaving the orchestrator and every sibling dispatch untouched. Descendants
// of the named dispatch cascade with it (DispatchRegistry.RecallByID walks the
// parent chain).
//
// Returns whether a matching live dispatch was found. A false return is a
// normal outcome, not an error: the dispatch may have completed between the
// consumer rendering its Stop affordance and the command arriving.
//
// The terminal-state machinery is already owned by the dispatch path: a recall
// sets recalled=true, which yields ExitCodeRecalled, transitions the agent
// slot to "cancelled", emits the agent snapshot, deregisters, and re-emits the
// dispatch count. Nothing needs to be emitted here.
func (m *Manager) AbortDispatch(key, dispatchID, reason string) bool {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "session", "abortdispatch: session not found", map[string]any{"key": key, "dispatch_id": dispatchID, "reason": reason})
		return false
	}
	if s.dispatchRegistry == nil {
		utils.LogWithFields(utils.LevelWarn, "session", "abortdispatch: session has no dispatch registry", map[string]any{"key": key, "dispatch_id": dispatchID, "reason": reason})
		return false
	}

	found := s.dispatchRegistry.RecallByID(dispatchID, reason)
	if found {
		utils.LogWithFields(utils.LevelInfo, "session", "abortdispatch: recalled dispatch", map[string]any{"key": key, "dispatch_id": dispatchID, "reason": reason})
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "abortdispatch: no live dispatch for id (already finished?)", map[string]any{"key": key, "dispatch_id": dispatchID, "reason": reason})
	}
	return found
}
