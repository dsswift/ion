// agent_snapshot_emit.go — the single funnel every engine_agent_state
// emission passes through.
//
// Why this exists: the event was constructed at ten separate call sites, two
// of which (prompt_extensions.go and start_session.go) were byte-identical
// copies of the same cache-then-merge-then-emit block carrying a "these must
// not diverge" comment. Ten construction sites means any cross-cutting
// concern — a size bound, a dedup gate, an advisory drain — has to be added
// ten times and can be forgotten in nine.
//
// The funnel also classifies each emission, which later gates depend on:
//
//   - force=true  — liveness emissions (heartbeat, reconcile) and terminal
//     transitions (abort, run exit, host death, rehydrate). For liveness the
//     REPEAT is the signal, so these must never be deduped or delayed.
//   - force=false — routine emissions driven by extension state changes.
//     These are eligible for dedup and coalescing.
//
// Locking: these functions call m.emit, which takes m.mu.RLock, so callers
// must NOT hold m.mu. A caller that already computed a snapshot (often under
// its own lock, since released) passes it to emitAgentSnapshot; a caller that
// has not calls emitAgentSnapshotFor and lets the funnel resolve it.
package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Emission reasons. Kept as constants so the log field is greppable and a
// typo cannot silently create a new reason that no dashboard knows about.
const (
	agentSnapshotReasonReconcile     = "reconcile"
	agentSnapshotReasonHeartbeat     = "heartbeat"
	agentSnapshotReasonAbort         = "abort"
	agentSnapshotReasonRunExit       = "run_exit"
	agentSnapshotReasonExtensionDied = "extension_died"
	agentSnapshotReasonRehydrate     = "rehydrate"
	agentSnapshotReasonDispatchCount = "dispatch_count"
	agentSnapshotReasonExtEmitMerged = "ext_emit_merged"
)

// emitAgentSnapshot emits a complete agent-state snapshot the caller already
// computed.
//
// snapshot may be empty or nil — an empty snapshot is the authoritative "no
// agents are live, wipe your view" signal and must reach consumers, so this
// never treats emptiness as "nothing to do" (see docs/architecture/agent-state.md).
func (m *Manager) emitAgentSnapshot(key, reason string, force bool, snapshot []types.AgentStateUpdate) {
	utils.LogWithFields(utils.LevelInfo, "session", "agent_snapshot_emitted", map[string]any{
		"key": key, "count": len(snapshot), "reason": reason, "force": force,
	})
	m.emit(key, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})
}

// emitAgentSnapshotFor resolves the session's current merged snapshot and
// emits it. Use when the caller does not already hold a computed snapshot.
//
// A missing session yields a nil snapshot rather than a skipped emission:
// callers reach here on paths where the client is expecting an authoritative
// answer, and silently emitting nothing would leave a reconnecting consumer
// showing stale rows forever.
func (m *Manager) emitAgentSnapshotFor(key, reason string, force bool) {
	m.mu.RLock()
	var snapshot []types.AgentStateUpdate
	if s, ok := m.sessions[key]; ok {
		snapshot = s.agents.MergedSnapshot()
	} else {
		utils.LogWithFields(utils.LevelWarn, "session", "agent_snapshot_emit: session not found, emitting empty snapshot", map[string]any{
			"key": key, "reason": reason,
		})
	}
	m.mu.RUnlock()

	m.emitAgentSnapshot(key, reason, force, snapshot)
}

// cacheExtStatesAndEmit is the shared body behind the two SetPersistentEmit
// wirings (start_session.go and prompt_extensions.go).
//
// Both intercept an extension's engine_agent_state and must re-emit a MERGED
// snapshot rather than forwarding the raw extension payload: the extension
// knows only its own roster, while the engine additionally tracks dispatch
// state (task, conversationId, progress). Because the event is a complete
// snapshot that consumers apply by replacement, forwarding the raw payload
// would erase every engine-managed entry on the consumer side.
//
// The two call sites used to hold byte-identical copies of this logic with a
// comment asking future editors to keep them in sync. This function removes
// the opportunity to fail at that.
func (m *Manager) cacheExtStatesAndEmit(key string, s *engineSession, agents []types.AgentStateUpdate) {
	s.agents.CacheExtStates(agents)
	m.emitAgentSnapshot(key, agentSnapshotReasonExtEmitMerged, false, s.agents.MergedSnapshot())
}
