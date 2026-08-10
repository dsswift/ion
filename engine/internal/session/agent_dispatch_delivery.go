package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// session's normal prompt queue. SendPrompt is intentionally the delivery
// primitive: it queues behind an active root run and starts an idle session,
// covering both completion races without trying to steer a tool execution that
// has not yet reached a drain checkpoint.
func (m *Manager) deliverRootDispatchResult(key string, result extension.DispatchAgentResult) {
	payload := formatRootDispatchResult(result)
	overrides := buildPromptOverrides("", nil, string(types.InjectionKindAgentCompletion))
	if err := m.SendPrompt(key, payload, overrides); err != nil {
		utils.LogWithFields(utils.LevelError, "session.dispatch_delivery", "root dispatch completion delivery failed", map[string]any{
			"session_id":  key,
			"dispatch_id": result.DispatchID,
			"model":       result.Name,
			"exit_code":   result.ExitCode,
			"error":       err.Error(),
		})
		return
	}
	m.emitPromptInjected(key, payload, string(types.InjectionKindAgentCompletion))
	utils.LogWithFields(utils.LevelInfo, "session.dispatch_delivery", "root dispatch completion delivered", map[string]any{
		"session_id":  key,
		"dispatch_id": result.DispatchID,
		"model":       result.Name,
		"exit_code":   result.ExitCode,
	})
}

func formatRootDispatchResult(result extension.DispatchAgentResult) string {
	status := "completed"
	switch result.ExitCode {
	case 0:
	case extcontextExitCodeRecalled:
		status = "recalled"
	default:
		status = "failed"
	}
	return fmt.Sprintf("[Agent %s %s]\nDispatch ID: %s\nElapsed: %.1fs\n\n%s",
		result.Name, status, result.DispatchID, result.Elapsed, result.Output)
}

// extcontextExitCodeRecalled mirrors the stable dispatch terminal code without
// exposing an internal package dependency to session.
const extcontextExitCodeRecalled = 2
