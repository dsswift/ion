package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Phase 2 of the state-management overhaul. Two related changes live
// here: a per-Manager heartbeat goroutine that periodically re-emits
// engine_status for every attached session, and an on-demand
// QuerySessionStatus RPC entrypoint that emits the same payload for a
// single key.
//
// Why both. The heartbeat covers steady-state convergence — any cache
// (desktop tab status, iOS pulse) that missed an organic status event
// will see the next heartbeat within DefaultSessionStatusHeartbeatInterval
// and reconcile. The on-demand RPC covers reconnect-time convergence —
// a freshly-attached desktop can ask the engine immediately for any
// key whose lastEngineEventAt is stale, rather than waiting up to one
// heartbeat interval. Both paths share the same SnapshotEngineStatus
// helper so the wire payload is identical.

// SetHeartbeatInterval overrides the heartbeat cadence. Intended for
// tests that need a short interval to assert behavior without blocking
// the suite on a 30 s ticker. Production callers leave the default in
// place. Setting the interval to zero or a negative duration restores
// the default.
//
// The call is safe to invoke at any point — the running goroutine
// re-reads the interval on every tick via snapshotHeartbeatInterval,
// so changes take effect after the current tick completes.
func (m *Manager) SetHeartbeatInterval(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d <= 0 {
		m.heartbeatInterval = DefaultSessionStatusHeartbeatInterval
		return
	}
	m.heartbeatInterval = d
}

// snapshotHeartbeatInterval reads heartbeatInterval under the manager
// lock. Used by runStatusHeartbeat so the running goroutine cannot
// race with SetHeartbeatInterval.
func (m *Manager) snapshotHeartbeatInterval() time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.heartbeatInterval <= 0 {
		return DefaultSessionStatusHeartbeatInterval
	}
	return m.heartbeatInterval
}

// runStatusHeartbeat is the per-Manager goroutine spawned by NewManager.
// It ticks every heartbeatInterval and re-emits engine_status for every
// attached session.
//
// Stop semantics: closing m.heartbeatStop terminates the goroutine on
// the next tick or stop check. Closing is idempotent
// (sync.Once-guarded in Shutdown). When the goroutine returns it closes
// m.heartbeatDone so that Shutdown (which waits on that channel) can
// unblock deterministically — no sleep-and-hope coordination required.
func (m *Manager) runStatusHeartbeat() {
	defer close(m.heartbeatDone)
	// Initial wait of one full interval so a freshly-created Manager
	// does not double-emit on startup (StartSession + immediate
	// heartbeat would be redundant).
	timer := time.NewTimer(m.snapshotHeartbeatInterval())
	defer timer.Stop()

	for {
		select {
		case <-m.heartbeatStop:
			return
		case <-timer.C:
			m.emitHeartbeatTick()
			// Re-read interval each tick so SetHeartbeatInterval
			// changes are picked up without restart.
			timer.Reset(m.snapshotHeartbeatInterval())
		}
	}
}

// emitHeartbeatTick iterates every attached session and emits a fresh
// engine_status and engine_agent_state snapshot for each.  Internal
// helper exported only for the unit test that exercises one tick
// directly without waiting on the timer.
//
// engine_status has been part of the heartbeat since Phase 2.
// engine_agent_state was added because there is no other periodic
// convergence mechanism for agent state — if a reconnecting client
// misses the one-shot reconcile_state, its agent panel is stranded
// until the next organic emission (which may never come for an idle
// session).  Emitting agent state on every tick closes that gap.
//
// Each emission flows through the same computation site as
// ReconcileState (currentSessionStatus) so a stranded requestID is
// cleared on the heartbeat tick too — convergence does not require a
// client to ask first.
func (m *Manager) emitHeartbeatTick() {
	m.mu.RLock()
	keys := make([]string, 0, len(m.sessions))
	for k := range m.sessions {
		keys = append(keys, k)
	}
	m.mu.RUnlock()

	if len(keys) == 0 {
		return
	}
	utils.Debug("Session", fmt.Sprintf("status_heartbeat_tick: emitting for %d sessions", len(keys)))

	for _, key := range keys {
		m.emitStatusSnapshot(key, "heartbeat")

		// Re-emit agent state so a reconnected client converges within
		// one tick even if reconcile_state was lost.
		m.mu.RLock()
		var agentSnapshot []types.AgentStateUpdate
		if s, ok := m.sessions[key]; ok {
			agentSnapshot = s.agents.MergedSnapshot()
		}
		m.mu.RUnlock()
		m.emit(key, types.EngineEvent{
			Type:   "engine_agent_state",
			Agents: agentSnapshot,
		})
	}
}

// emitStatusSnapshot builds the engine_status payload for the given
// key and emits it. Internal helper shared by the heartbeat path, the
// on-demand QuerySessionStatus RPC, and ReconcileState.
//
// `reason` is a free-form label that lands in the status-emit log line
// so investigations can tell heartbeat traffic apart from on-demand
// queries and from organic state transitions. Not part of the wire
// payload.
//
// The payload mirrors what ReconcileState emits today: state +
// context/cost/model + retained PermissionDenials. Keeping the
// payload identical means downstream consumers (desktop renderer, iOS
// view model) need no awareness of which path produced the event.
//
// Phase 3: the Manager.emit chokepoint mirrors every emitted
// engine_status into an engine_session_status, so this helper does
// NOT emit the new event directly — that would double-emit. See
// Manager.emit + buildSessionStatusMirror in manager.go.
func (m *Manager) emitStatusSnapshot(key, reason string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}
	// Compute the authoritative state under the lock so the
	// cross-check's defensive clear is observed atomically with the
	// emission. currentSessionStatus only writes s.requestID, which is
	// covered by the manager lock — we promote to write here so the
	// clear is race-free.
	m.mu.RUnlock()
	m.mu.Lock()
	sessionState := m.currentSessionStatus(s)
	pendingDenials := s.lastPermissionDenials
	lastPct := s.lastContextPct
	lastWindow := s.lastContextWindow
	lastModel := s.lastModel
	lastCost := s.lastTotalCost
	sessionID := s.conversationID
	bgCount := 0
	if s.dispatchRegistry != nil {
		bgCount = len(s.dispatchRegistry.ActiveIDs())
	}
	m.mu.Unlock()

	utils.Log("Session", fmt.Sprintf("status_snapshot_emitted key=%s state=%s reason=%s pendingDenials=%d model=%s contextPct=%d backgroundAgents=%d", key, sessionState, reason, len(pendingDenials), lastModel, lastPct, bgCount))
	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			Label:             key,
			State:             sessionState,
			SessionID:         sessionID,
			ContextPercent:    lastPct,
			ContextWindow:     lastWindow,
			Model:             lastModel,
			TotalCostUsd:      lastCost,
			PermissionDenials: pendingDenials,
			BackgroundAgents:  bgCount,
		},
	})
}

// QuerySessionStatus emits a fresh engine_status snapshot for the
// given key. Wire-protocol entrypoint for the query_session_status
// client command — desktop and iOS use this on attach / reconnect to
// learn current state without waiting for the next heartbeat tick.
//
// Semantically identical to ReconcileState's status-emit path: the
// authoritative state is recomputed via currentSessionStatus (so a
// stranded requestID is cleared on demand), and the retained
// PermissionDenials are re-published so a reattaching consumer sees
// the full snapshot.
//
// Differs from ReconcileState in that it does NOT re-emit
// engine_agent_state. The caller asked specifically about status —
// re-emitting the full agent snapshot would conflate two concerns.
// Callers that want the full reconcile use the existing reconcile_state
// command; callers that only need status freshness use this.
//
// Returns silently when no session exists for the key, matching the
// behavior of ReconcileState. A Warn log fires so an out-of-sync
// caller is visible in the engine log.
func (m *Manager) QuerySessionStatus(key string) {
	m.mu.RLock()
	_, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.Warn("Session", fmt.Sprintf("QuerySessionStatus: session not found key=%s", key))
		return
	}
	m.emitStatusSnapshot(key, "query")
}
