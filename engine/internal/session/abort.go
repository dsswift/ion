package session

import (

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SendAbort cancels the active run for the given session and reaps any
// dispatched child agents so they do not continue running standalone.
func (m *Manager) SendAbort(key string) {
	utils.LogWithFields(utils.LevelInfo, "session", "sendabort", map[string]any{"key": key})
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session", "sendabort: session not found for", map[string]any{"key": key})
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
	// We deliberately do NOT clear s.requestID here: the run goroutine and
	// its cancel watchdog own the requestID lifecycle and clear it via
	// handleRunExit on real exit. Clearing it out from under them would
	// desync the backend's per-run watchdog / terminal-status contract and
	// risk a double dispatch.
	if dropped := len(s.promptQueue); dropped > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "sendabort: dropping queued prompt(s) for", map[string]any{"dropped": dropped, "key": key})
		s.promptQueue = nil
	}
	m.mu.Unlock()

	// Cancel the session's cancellation root first. This cascades through
	// the Go context tree to every descendant that derived from it — the
	// backend run (via RunOptions.ParentCtx), dispatched child agents'
	// in-process contexts, and any in-flight ctx.llmCall(). The explicit
	// backend.Cancel(rid) and abortAllDescendants calls below remain as
	// belt-and-suspenders: backend.Cancel drives the per-run watchdog /
	// terminal-status emission contract, and abortAllDescendants performs
	// the OS-process kill that a context cancel alone cannot do for child
	// agents running as separate processes.
	s.cancelSessionRoot("user abort")

	if rid != "" {
		utils.LogWithFields(utils.LevelInfo, "session", "sendabort: cancelling for", map[string]any{"run_id": rid, "key": key})
		m.backend.Cancel(rid)
	} else {
		utils.LogWithFields(utils.LevelWarn, "session", "sendabort: no active requestid for (reaping descendants only)", map[string]any{"key": key})
	}
	// Always reap descendants — they may outlive the parent run
	m.abortAllDescendants(key, "user abort")
}

// abortAllDescendants kills every agent registered for this session and
// transitions their engine-managed states to "cancelled" so the next
// emitted snapshot reflects reality. Called when the parent run dies
// (error/non-zero exit) or the user interrupts so dispatched agents do
// not continue running standalone and burning model budget.
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
		snapshot := s.agents.MergedSnapshot()
		utils.LogWithFields(utils.LevelInfo, "session", "agent_snapshot_emitted reason=abort", map[string]any{"key": key, "count": len(snapshot)})
		m.emit(key, types.EngineEvent{
			Type:   "engine_agent_state",
			Agents: snapshot,
		})
	} else {
		utils.LogWithFields(utils.LevelDebug, "session", "abortalldescendants: skipping engine snapshot — extension owns agent registry", map[string]any{"key": key})
	}
}
