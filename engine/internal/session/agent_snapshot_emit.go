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
	"time"

	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// clampAdvisoryRecord remembers the last advisory emitted for one
// (agent, scope) pair so repeats inside the window can be suppressed.
type clampAdvisoryRecord struct {
	at            time.Time
	originalBytes int
}

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
	m.mu.RLock()
	s := m.sessions[key]
	m.mu.RUnlock()

	// No session (teardown races, some test harnesses): no gate state exists,
	// so emit unconditionally rather than dropping an authoritative frame.
	if s == nil || s.agentEmitter == nil {
		projected, reports := agents.ClampSnapshotCopy(snapshot, m.agentMetadataLimits())
		m.publishAgentSnapshot(key, reason, force, projected, reports)
		return
	}

	metadataLimits := m.agentMetadataLimits()
	projected, reports := agents.ClampSnapshotCopy(snapshot, metadataLimits)
	limits := m.agentStateEmitLimits()
	decision := s.agentEmitter.decide(projected, reason, force, limits,
		func(flushReason string, coalesced int) {
			// Trailing edge: re-read the CURRENT snapshot rather than reusing
			// the one that opened the window, so the coalesced emission
			// carries final state. That is what makes collapsing a burst
			// lossless rather than merely cheaper.
			m.mu.RLock()
			var latest []types.AgentStateUpdate
			if sess, ok := m.sessions[key]; ok {
				latest = sess.agents.MergedSnapshot()
			}
			m.mu.RUnlock()

			utils.LogWithFields(utils.LevelDebug, "session", "agent_state: flushing coalesced burst", map[string]any{
				"key": key, "reason": flushReason, "absorbed": coalesced,
			})
			projectedLatest, latestReports := agents.ClampSnapshotCopy(latest, metadataLimits)
			m.publishAgentSnapshot(key, flushReason, false, projectedLatest, latestReports)
		})

	switch decision {
	case emitSuppress, emitDefer:
		return
	default:
		m.publishAgentSnapshot(key, reason, force, projected, reports)
	}
}

// publishAgentSnapshot performs the actual emission, past every gate.
func (m *Manager) publishAgentSnapshot(key, reason string, force bool, snapshot []types.AgentStateUpdate, reports []agents.ClampReport) {
	// Publish any clamp advisories BEFORE the snapshot they describe, so a
	// consumer that reacts to the advisory has it in hand by the time the
	// clamped payload arrives rather than one frame late.
	m.emitClampAdvisories(key, reports)

	utils.LogWithFields(utils.LevelInfo, "session", "agent_snapshot_emitted", map[string]any{
		"key": key, "count": len(snapshot), "reason": reason, "force": force,
	})
	m.emit(key, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})
}

// agentStateEmitLimits resolves the dedup/coalesce configuration.
func (m *Manager) agentStateEmitLimits() types.ResolvedAgentStateEmitLimits {
	if m == nil || m.config == nil {
		return types.AgentStateEmitDefaults()
	}
	return m.config.Limits.AgentStateEmit.Resolved()
}

// clampAdvisoryInterval is the per-(agent, scope) floor between advisories.
//
// Rate limiting is not cosmetic here. The production payload was clamped on
// every one of 1,873 emissions over 15 hours; an unthrottled advisory would
// have added 1,873 events describing the same unchanging condition, which is
// the same "flood the wire" failure the clamp exists to stop.
const clampAdvisoryInterval = 60 * time.Second

// emitClampAdvisories drains the registry's clamp reports and emits a typed
// advisory for each, subject to the rate limit.
//
// Every clamp is logged at WARN unconditionally by the clamp itself; the rate
// limit applies only to the wire event. Diagnosing from logs therefore stays
// complete even when the event stream is throttled.
func (m *Manager) emitClampAdvisories(key string, reports []agents.ClampReport) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok || s == nil || len(reports) == 0 {
		return
	}

	now := time.Now()
	for _, rep := range reports {
		if !s.shouldEmitClampAdvisory(rep, now) {
			continue
		}
		m.emit(key, types.EngineEvent{
			Type:                 "engine_agent_state_clamped",
			ClampedAgentName:     rep.AgentName,
			ClampedScope:         rep.Scope,
			ClampedKeys:          rep.ClampedKeys,
			ClampedDroppedKeys:   rep.DroppedKeys,
			ClampedOriginalBytes: rep.OriginalBytes,
			ClampedBytes:         rep.ClampedBytes,
			ClampedLimitBytes:    rep.LimitBytes,
		})
	}
}

// shouldEmitClampAdvisory applies the per-(agent, scope) rate limit.
//
// A materially different size always emits, even inside the window: a payload
// that grew by an order of magnitude is new information, not a repeat of the
// condition already reported.
func (s *engineSession) shouldEmitClampAdvisory(rep agents.ClampReport, now time.Time) bool {
	s.clampAdvisoryMu.Lock()
	defer s.clampAdvisoryMu.Unlock()

	if s.lastClampAdvisory == nil {
		s.lastClampAdvisory = make(map[string]clampAdvisoryRecord)
	}
	sig := rep.AgentName + "\x00" + rep.Scope

	prev, seen := s.lastClampAdvisory[sig]
	if seen && now.Sub(prev.at) < clampAdvisoryInterval && !materiallyDifferent(prev.originalBytes, rep.OriginalBytes) {
		return false
	}
	s.lastClampAdvisory[sig] = clampAdvisoryRecord{at: now, originalBytes: rep.OriginalBytes}
	return true
}

// materiallyDifferent reports whether two sizes differ enough to be worth a
// fresh advisory inside the rate-limit window (a 2x change either way).
func materiallyDifferent(prev, cur int) bool {
	if prev <= 0 {
		return cur > 0
	}
	return cur >= prev*2 || cur*2 <= prev
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
