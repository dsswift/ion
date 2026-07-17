package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// permissionAskClosure builds the shared "ask" bridge used by every delegated
// CLI backend (claude-code's hook server and codex's approval requests). On an
// "ask" decision it registers a pending permission, emits
// engine_permission_request, and returns a channel that resolves to the chosen
// option ID once the user responds. Extracted so the claude-code and codex
// paths share one implementation.
func (m *Manager) permissionAskClosure(key string) backend.PermissionAskCallback {
	return func(_ string, questionID string, toolName string, toolDesc string, toolInput map[string]any, options []types.PermissionOpt) chan string {
		ch := m.RegisterPendingPermission(key, questionID)
		if ch == nil {
			return nil
		}
		m.emit(key, types.EngineEvent{
			Type:          "engine_permission_request",
			QuestionID:    questionID,
			PermToolName:  toolName,
			PermToolDesc:  toolDesc,
			PermToolInput: toolInput,
			PermOptions:   options,
		})
		result := make(chan string, 1)
		go func() {
			optionID := <-ch
			m.UnregisterPendingPermission(key, questionID)
			result <- optionID
		}()
		return result
	}
}

// wireDelegatedPermissions installs the permission-ask bridge on any delegated
// CLI backend (codex, grok, cursor) that asks the engine to approve tool calls.
// Those backends send tool-approval requests over JSON-RPC; the bridge surfaces
// them as engine_permission_request events, identical to the claude-code hook
// path. A no-op for the API and claude-code backends.
func (m *Manager) wireDelegatedPermissions(key string, opts *types.RunOptions) {
	askable, ok := m.resolvedBackend(opts.Model).(backend.PermissionAskable)
	if !ok {
		return
	}
	askable.SetPermissionAskCallback(m.permissionAskClosure(key))
	utils.LogWithFields(utils.LevelInfo, "session", "delegated permission bridge wired", map[string]any{"model": opts.Model})
}
