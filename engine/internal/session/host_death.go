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
// at the moment of death (so turn_aborted can fire on the new instance) and
// emits the typed engine_extension_died wire event. The actual respawn is
// deferred to handleRunExit when the active run finishes — never mid-turn.
func (m *Manager) handleHostDeath(key string, h *extension.Host) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}
	turnActive := s.requestID != ""
	m.mu.RUnlock()

	h.MarkTurnInFlight(turnActive)

	exitCode, signal := h.LastExit()
	utils.Warn("Session", fmt.Sprintf("extension subprocess died: key=%s ext=%s code=%v signal=%q turnActive=%v",
		key, h.Name(), exitCode, signal, turnActive))

	m.emit(key, types.EngineEvent{
		Type:          "engine_extension_died",
		ExtensionName: h.Name(),
		ExitCode:      exitCode,
		Signal:        &signal,
	})

	// Notify peers in the same session that a sibling died. Observational
	// only — peers can't prevent the death, but they can degrade
	// gracefully (mark dependent state as stale, etc.).
	m.firePeerExtensionDied(key, h, exitCode, signal)

	// If no run is active, respawn immediately. Otherwise the manager's
	// handleRunExit will call respawnDeadExtensions after the run ends.
	if !turnActive {
		m.respawnDeadExtensions(key)
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
			Type:   "engine_status",
			Fields: &types.StatusFields{Label: key, State: "extension_restarting"},
		})

		attempt, err := h.Respawn()
		if err != nil {
			if errors.Is(err, extension.ErrBudgetExceeded) {
				utils.Error("Session", fmt.Sprintf("extension respawn budget exceeded: key=%s ext=%s attempts=%d", key, h.Name(), attempt))
				m.emit(key, types.EngineEvent{
					Type:          "engine_extension_dead_permanent",
					ExtensionName: h.Name(),
					AttemptNumber: attempt,
				})
				continue
			}
			utils.Error("Session", fmt.Sprintf("extension respawn failed: key=%s ext=%s err=%v", key, h.Name(), err))
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("extension %s respawn failed: %v", h.Name(), err),
				ErrorCode:    "extension_respawn_failed",
			})
			continue
		}

		utils.Info("Session", fmt.Sprintf("extension respawned: key=%s ext=%s attempt=%d", key, h.Name(), attempt))

		// Fire extension_respawned on the new instance so the harness
		// can rebuild caches.
		_ = h.SDK().FireExtensionRespawned(ctx, extension.ExtensionRespawnedInfo{
			AttemptNumber: attempt,
			PrevExitCode:  prevExitCode,
			PrevSignal:    prevSignal,
		})

		// If the prior instance died mid-turn, signal that the missed
		// turn lifecycle was interrupted. The harness can use this to
		// reset per-turn state it was tracking.
		if hadTurnInFlight {
			_ = h.SDK().FireTurnAborted(ctx, extension.TurnAbortedInfo{Reason: "extension_died"})
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
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "idle"},
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
		_ = h.SDK().FirePeerExtensionDied(ctx, info)
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
		_ = h.SDK().FirePeerExtensionRespawned(ctx, info)
	}
}
