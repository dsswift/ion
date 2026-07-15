package session

import (
	"errors"
	"strings"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// emitExtensionRespawnTelemetry emits an extension.respawn telemetry event for
// a completed respawn attempt (family 4e). Nil-safe on the session's collector.
// outcome distinguishes a successful respawn ("respawned"), a budget-exhausted
// terminal state ("budget_exceeded"), or a spawn failure ("spawn_failed").
func (m *Manager) emitExtensionRespawnTelemetry(s *engineSession, key string, h *extension.Host, attempt int, err error) {
	if s == nil || s.telemetry == nil {
		return
	}
	outcome := "respawned"
	if errors.Is(err, extension.ErrBudgetExceeded) {
		outcome = "budget_exceeded"
	} else if err != nil {
		outcome = "spawn_failed"
	}
	exitCode, exitSignal := h.LastExit()
	precedingOp := "idle"
	if h.TurnInFlightAtDeath() {
		precedingOp = "turn_in_flight"
	}
	var exitCodeAny any
	if exitCode != nil {
		exitCodeAny = *exitCode
	}
	// R11: event name is carried by Event.Name at the top level; payload.kind
	// is redundant and has been removed from all telemetry emitters.
	s.telemetry.Event(telemetry.ExtensionRespawn, map[string]any{
		"extension":           h.Name(),
		"attempt":             attempt,
		"budget_max":          h.RespawnBudget(),
		"preceding_operation": precedingOp,
		"exit_code":           exitCodeAny,
		"exit_signal":         exitSignal,
		"outcome":             outcome,
	}, correlationCtx(key, s.conversationID))
	utils.LogWithFields(utils.LevelDebug, "session", "extension.respawn telemetry emitted ext= outcome=", map[string]any{"model": h.Name(), "outcome": outcome})
}

// emitExtensionColdstartTelemetry emits an extension.coldstart telemetry event
// for a freshly loaded extension host (family 4e). Nil-safe on the collector.
// extPath is the extension entry-point path, used to report whether the source
// was TypeScript (transpiled) or plain JavaScript.
func (m *Manager) emitExtensionColdstartTelemetry(s *engineSession, key string, h *extension.Host, extPath string) {
	if s == nil || s.telemetry == nil {
		return
	}
	// R11: event name is carried by Event.Name at the top level; payload.kind
	// is redundant and has been removed from all telemetry emitters.
	s.telemetry.Event(telemetry.ExtensionColdstart, map[string]any{
		"extension":     h.Name(),
		"ready_ms":      h.SpawnReadyMs(),
		"cold":          true,
		"transpiled_ts": strings.HasSuffix(extPath, ".ts"),
	}, correlationCtx(key, s.conversationID))
	utils.LogWithFields(utils.LevelDebug, "session", "extension.coldstart telemetry emitted ext=", map[string]any{"model": h.Name()})
}
