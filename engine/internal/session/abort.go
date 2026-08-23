package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SendAbort cancels the active run for the given session and reaps any
// dispatched child agents so they do not continue running standalone.
//
// This is the full-teardown scope. It is kept as its own exported method
// (rather than folded into SendAbortScoped) because it is the signature every
// external Go-SDK consumer and in-repo caller already builds against; the
// scoped variant is additive. See abort_scope.go for the scope semantics.
func (m *Manager) SendAbort(key string) {
	m.SendAbortScoped(key, AbortScopeAll)
}

// abortAllDescendants stops every descendant of this session — background
// dispatches held in the DispatchRegistry and agent processes registered as
// handles — and transitions their engine-managed states to "cancelled" so the
// next emitted snapshot reflects reality. Called when the parent run dies
// (error/non-zero exit) or the user interrupts so dispatched agents do
// not continue running standalone and burning model budget.
//
// The two registries are genuinely separate populations, and this is the only
// place that covers both:
//
//   - DispatchRegistry holds engine-native dispatches (ctx.DispatchAgent and
//     the orchestrator's Agent tool). They are cancelled by recall, which
//     drives their normal terminal path (cancelled status, snapshot,
//     deregister, dispatch-count re-emit).
//   - agents.Registry holds OS-process handles registered via
//     ctx.RegisterAgent. Those need a PID kill; a context cancel cannot reach
//     another process.
//
// The recall runs FIRST, before the handle sweep's zero-handle early return.
// Ordering is load-bearing: engine-native dispatches register no handle, so a
// session whose only descendants are dispatches has zero PIDs, and a recall
// placed after that return would never execute. That was the defect this
// ordering fixes — the desktop's "reap the subtree" call was a no-op for every
// engine-native dispatch, and only the session-root cascade stopped them.
//
// Engine contract: `engine_agent_state` events are complete snapshots.
// Every code path that ends an agent's run must transition the registry
// to a terminal status (done/error/cancelled) before emitting, so the
// next snapshot is authoritative. See docs/architecture/agent-state.md.
func (m *Manager) abortAllDescendants(key, reason string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.LogWithFields(utils.LevelWarn, "session", "abortalldescendants: session not found", map[string]any{"key": key, "reason": reason})
		return
	}
	hasExt := s.extGroup != nil && !s.extGroup.IsEmpty()
	m.mu.RUnlock()

	// Recall live background dispatches. Each recall cancels the dispatch's
	// context and cascades to its descendants; the dispatch's own exit path
	// emits its terminal state and deregisters it.
	if s.dispatchRegistry != nil {
		if recalled := s.dispatchRegistry.RecallAll(reason); recalled > 0 {
			utils.LogWithFields(utils.LevelInfo, "session", "abortalldescendants: recalled background dispatch(es)", map[string]any{"key": key, "reason": reason, "count": recalled})
		}
	}

	pids, names := s.agents.ClearHandles()
	if len(pids) == 0 {
		utils.LogWithFields(utils.LevelDebug, "session", "abortalldescendants: no handles to clear", map[string]any{"key": key, "reason": reason})
		return
	}

	utils.LogWithFields(utils.LevelWarn, "session", "aborting descendant agent(s) ()", map[string]any{"count": len(pids), "reason": reason, "key": key, "model": names})
	for _, pid := range pids {
		killProcess(pid)
	}

	// Transition every engine-managed state for the killed handles to
	// "cancelled" so the snapshot we emit (and any subsequent reconcile)
	// reflects that these agents are no longer running. Without this,
	// MergedSnapshot() would still report them as running and a future
	// ReconcileState would re-broadcast stale rows.
	for _, name := range names {
		s.agents.UpdateState(name, func(state *types.AgentStateUpdate) {
			state.Status = "cancelled"
			if state.Metadata == nil {
				state.Metadata = map[string]interface{}{}
			}
			state.Metadata["lastWork"] = "cancelled: " + reason
		})
		utils.LogWithFields(utils.LevelInfo, "session", "agent_terminated status=cancelled", map[string]any{"model": name, "reason": reason, "key": key})
	}

	// Emit the authoritative snapshot. Skip only when the session has
	// an extension group — extensions own their agent registry and will
	// publish their own snapshot. Even then, the engine emits a
	// corrective snapshot on extension death (see handleHostDeath).
	if !hasExt {
		// force=true: an abort is a terminal transition, and agent-state.md
		// requires every path that ends a run to deliver the resulting
		// terminal status. Delaying or suppressing it would leave consumers
		// rendering aborted agents as still running.
		m.emitAgentSnapshot(key, agentSnapshotReasonAbort, true, s.agents.MergedSnapshot())
	} else {
		utils.LogWithFields(utils.LevelDebug, "session", "abortalldescendants: skipping engine snapshot — extension owns agent registry", map[string]any{"key": key})
	}
}
