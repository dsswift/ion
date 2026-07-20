package session

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// handleHostDeath is invoked from a goroutine after the Host's reader loop
// detects the subprocess has died. It records whether a turn was in flight
// at the moment of death (so turn_aborted can fire on the new instance),
// emits the typed engine_extension_died wire event, and emits a corrective
// `engine_agent_state` snapshot drawn from the engine's own registry so
// stale "running" rows the extension last published do not linger across
// the death/respawn window.
//
// Engine contract: `engine_agent_state` is a complete snapshot. When the
// authoritative emitter (the extension) goes away, the engine must publish
// a replacement snapshot reflecting reality from its own registry — the
// extension's last cache cannot be trusted to represent the live world.
// See docs/architecture/agent-state.md.
//
// The actual respawn is deferred to handleRunExit when the active run
// finishes — never mid-turn.
func (m *Manager) handleHostDeath(key string, h *extension.Host) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.LogWithFields(utils.LevelWarn, "session", "handlehostdeath: session not found", map[string]any{"key": key, "model": h.Name()})
		return
	}
	turnActive := s.requestID != ""
	m.mu.RUnlock()

	h.MarkTurnInFlight(turnActive)

	exitCode, signal := h.LastExit()
	utils.LogWithFields(utils.LevelWarn, "session", "extension subprocess died", map[string]any{"session_id": key, "model": h.Name(), "exit_code": exitCode, "signal": signal, "turn_active": turnActive})

	m.emit(key, types.EngineEvent{
		Type:          "engine_extension_died",
		ExtensionName: h.Name(),
		ExitCode:      exitCode,
		Signal:        &signal,
		StderrTail:    h.StderrTail(),
	})

	// Emit a corrective agent_state snapshot. The dead extension's cached
	// state (lastExtStates) typically contains agents in "running" — those
	// rows are now stale because the process that was driving them is gone.
	// Drop the cached extension states and emit whatever the engine's own
	// registry holds (engine-managed Agent tool sub-agents only). Consumers
	// must replace their view per the snapshot contract.
	//
	// When the extension respawns, its session_start hook will re-emit a
	// fresh snapshot and the cache will be repopulated naturally.
	prevExtCount := len(s.agents.LastExtStates())
	s.agents.CacheExtStates(nil)
	snapshot := s.agents.MergedSnapshot()
	utils.LogWithFields(utils.LevelInfo, "session", "agent_recovery_snapshot reason=extension_died", map[string]any{"key": key, "model": h.Name(), "prev_ext_count": prevExtCount, "count": len(snapshot)})
	m.emit(key, types.EngineEvent{
		Type:   "engine_agent_state",
		Agents: snapshot,
	})

	// Notify peers in the same session that a sibling died. Observational
	// only — peers can't prevent the death, but they can degrade
	// gracefully (mark dependent state as stale, etc.).
	m.firePeerExtensionDied(key, h, exitCode, signal)

	// Release any runOnce leases this host was holding. If the host crashed
	// mid-operation without sending run_once_complete, the running flag
	// would otherwise block all other instances until debounce expiry.
	// Releasing here lets the next instance retry immediately.
	extDir := h.ExtensionDir()
	if extDir != "" {
		for _, opID := range m.runOnce.runningIDs(extDir) {
			m.runOnce.releaseRunning(extDir, opID)
		}
	}

	// If no run is active, respawn immediately. Otherwise the manager's
	// handleRunExit will call respawnDeadExtensions after the run ends.
	if !turnActive {
		utils.LogWithFields(utils.LevelDebug, "session", "handlehostdeath: no active turn — respawning immediately", map[string]any{"key": key, "model": h.Name()})
		m.respawnDeadExtensions(key)
	} else {
		utils.LogWithFields(utils.LevelDebug, "session", "handlehostdeath: deferring respawn until run exits", map[string]any{"key": key, "model": h.Name()})
	}
}

// respawnDeadExtensions iterates the session's extension group and
// respawns any host whose subprocess is dead. Called from handleRunExit
// after a run completes (so respawn never overlaps with an active turn).
// Each successful respawn fires extension_respawned (and turn_aborted, if
// the host died with a turn in flight) on the new instance and
// peer_extension_respawned on every other host in the group.
func (m *Manager) respawnDeadExtensions(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.extGroup == nil {
		m.mu.RUnlock()
		return
	}
	hosts := s.extGroup.Hosts()
	ctx := m.newExtContext(s, key)
	m.mu.RUnlock()

	for _, h := range hosts {
		if !h.Dead() {
			continue
		}

		prevExitCode, prevSignal := h.LastExit()
		hadTurnInFlight := h.TurnInFlightAtDeath()

		m.emit(key, types.EngineEvent{
			Type: "engine_status",
			Fields: &types.StatusFields{
				Label: key, State: "extension_restarting",
				ContextPercent: s.lastContextPct,
				ContextWindow:  s.lastContextWindow,
				Model:          s.lastModel,
				RunCostUsd:     s.lastTotalCost,
			},
		})

		attempt, err := h.Respawn()
		if err != nil {
			m.emitExtensionRespawnTelemetry(s, key, h, attempt, err)
			if errors.Is(err, extension.ErrBudgetExceeded) {
				utils.LogWithFields(utils.LevelError, "session", "extension respawn budget exceeded", map[string]any{"key": key, "model": h.Name(), "attempt": attempt})
				m.emit(key, types.EngineEvent{
					Type:          "engine_extension_dead_permanent",
					ExtensionName: h.Name(),
					AttemptNumber: attempt,
					StderrTail:    h.StderrTail(),
				})
				continue
			}
			utils.LogWithFields(utils.LevelError, "session", "extension respawn failed", map[string]any{"key": key, "model": h.Name(), "error": err})
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("extension %s respawn failed: %v", h.Name(), err),
				ErrorCode:    "extension_respawn_failed",
			})
			continue
		}

		utils.LogWithFields(utils.LevelInfo, "session", "extension respawned", map[string]any{"key": key, "model": h.Name(), "attempt": attempt})
		m.emitExtensionRespawnTelemetry(s, key, h, attempt, nil)

		// On respawn, the previous subprocess's webhook/schedule
		// registrations are gone with it but the per-host registry
		// survived (it lives on the Host, not the subprocess).
		// Wipe it before re-committing the new init payload so
		// re-registration doesn't collide with stale entries.
		h.ResetAsyncRegistrations()
		m.commitHostInitAsyncDecls(key, h)

		// Rewire resource query handlers onto the existing broker producers
		// and re-deliver snapshots to subscribers. This corrects the empty-
		// snapshot that was delivered when the initial query failed because
		// the first subprocess died before it could answer the resource/query
		// RPC. The broker's producer entries already exist (registered during
		// CommitPendingResourceDecls on first spawn); RewireResourceDecls
		// updates their query handlers to point to the live subprocess and
		// pushes a fresh snapshot to every active subscriber.
		if broker := m.ResourceBroker(key); broker != nil {
			h.RewireResourceDecls(broker)
		}

		// Fire extension_respawned on the new instance so the harness
		// can rebuild caches.
		h.SDK().FireExtensionRespawned(ctx, extension.ExtensionRespawnedInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
			AttemptNumber: attempt,
			PrevExitCode:  prevExitCode,
			PrevSignal:    prevSignal,
		})

		// If the prior instance died mid-turn, signal that the missed
		// turn lifecycle was interrupted. The harness can use this to
		// reset per-turn state it was tracking.
		if hadTurnInFlight {
			h.SDK().FireTurnAborted(ctx, extension.TurnAbortedInfo{Reason: "extension_died"}) //nolint:errcheck // errors logged internally by fireVoid/s.fire
		}

		// Notify peers that the sibling came back.
		m.firePeerExtensionRespawned(key, h, attempt)

		m.emit(key, types.EngineEvent{
			Type:          "engine_extension_respawned",
			ExtensionName: h.Name(),
			AttemptNumber: attempt,
		})
	}

	// Settle status back to idle once all hosts have been processed.
	m.mu.RLock()
	var idlePct, idleCW int
	var idleModel string
	var idleCost, idleConvCost float64
	if sess, ok2 := m.sessions[key]; ok2 {
		idlePct = sess.lastContextPct
		idleCW = sess.lastContextWindow
		idleModel = sess.lastModel
		idleCost = sess.lastTotalCost
		idleConvCost = sess.lastConvCost
	}
	m.mu.RUnlock()
	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			Label: key, State: "idle",
			ContextPercent: idlePct, ContextWindow: idleCW,
			Model: idleModel, RunCostUsd: idleCost, ConversationCostUsd: idleConvCost,
		},
	})
}

// firePeerExtensionDied fires peer_extension_died on every Host in the
// group except the one that died.
func (m *Manager) firePeerExtensionDied(key string, dead *extension.Host, exitCode *int, signal string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.extGroup == nil {
		m.mu.RUnlock()
		return
	}
	hosts := s.extGroup.Hosts()
	ctx := m.newExtContext(s, key)
	m.mu.RUnlock()

	info := extension.PeerExtensionInfo{
		Name:     dead.Name(),
		ExitCode: exitCode,
		Signal:   signal,
	}
	for _, h := range hosts {
		if h == dead || h.Dead() {
			continue
		}
		h.SDK().FirePeerExtensionDied(ctx, info) //nolint:errcheck // errors logged internally by fireVoid/s.fire
	}
}

// firePeerExtensionRespawned fires peer_extension_respawned on every Host
// in the group except the one that just respawned.
func (m *Manager) firePeerExtensionRespawned(key string, respawned *extension.Host, attempt int) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.extGroup == nil {
		m.mu.RUnlock()
		return
	}
	hosts := s.extGroup.Hosts()
	ctx := m.newExtContext(s, key)
	m.mu.RUnlock()

	info := extension.PeerExtensionInfo{
		Name:          respawned.Name(),
		AttemptNumber: attempt,
	}
	for _, h := range hosts {
		if h == respawned || h.Dead() {
			continue
		}
		h.SDK().FirePeerExtensionRespawned(ctx, info) //nolint:errcheck // errors logged internally by fireVoid/s.fire
	}
}
